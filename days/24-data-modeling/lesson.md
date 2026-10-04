# Data Modeling

> Before you write a line of backend code, you decide what tables (or documents) exist and how they connect. Get it right and features are easy to add; get it wrong and every query fights you. Today you learn the rules (normalization), when to break them (denormalization), and how to model a real app from its access patterns.

## The big idea

Imagine a school keeps one giant spreadsheet: every row is a student-class enrollment, with the student's name, phone, the class name, the teacher's name and the teacher's office.

```text
student | student_phone | class    | teacher | teacher_office
Ana     | 010-1111      | Math     | Mr. Lee | B201
Ana     | 010-1111      | History  | Ms. Kim | C105
Bo      | 010-2222      | Math     | Mr. Lee | B201
```

Three problems appear immediately:

- **Update anomaly:** Mr. Lee moves to office B305. You must change *every* Math row. Miss one and the data contradicts itself.
- **Insert anomaly:** a new teacher with no classes yet can't be recorded at all.
- **Delete anomaly:** if Bo and Ana drop Math, you lose the fact that Mr. Lee exists.

The fix: **store each fact exactly once** and link facts by keys. That's **normalization**. The opposite, deliberately storing a fact in several places to make reads faster, is **denormalization**. Data modeling is choosing where on that line each piece of data should sit.

## Normalization in plain words

The formal "normal forms" sound scary but boil down to one sentence (a classic mnemonic): *every non-key column must depend on **the key**, **the whole key**, and **nothing but the key**.*

- **1NF (first normal form):** each cell holds one value; no lists in a column (`tags = "a,b,c"` breaks it), no repeating columns (`phone1, phone2, phone3`).
- **2NF:** if the key has several columns, no column may depend on just part of it. In `enrollments(student_id, class_id, class_name)`, `class_name` depends only on `class_id`, so it belongs in `classes`.
- **3NF:** no column depends on another non-key column. In `classes(id, teacher, teacher_office)`, the office depends on the teacher, so it belongs in `teachers`.

The school, normalized:

```text
students(id, name, phone)
teachers(id, name, office)
classes(id, name, teacher_id -> teachers.id)
enrollments(student_id -> students.id, class_id -> classes.id)   PK (student_id, class_id)
```

Mr. Lee's office now lives in exactly one row.

## The three relationship shapes

**One-to-one:** a user has one profile. Usually just columns on the same table; split into a second table only for a reason (rarely used, large, or sensitive data).

**One-to-many:** a user writes many posts. Put the foreign key on the **many** side.

```text
users(id, ...)            posts(id, author_id -> users.id, caption, created_at)
```

**Many-to-many:** users like many posts; posts are liked by many users. Use a **join table** (also called junction or association table), whose primary key is the pair.

```text
likes(user_id -> users.id, post_id -> posts.id, created_at)   PK (user_id, post_id)
```

The composite primary key does double duty: it makes "like the same post twice" impossible, and it's an index for "has user X liked post Y?". Add a second index on `(post_id, created_at)` for "who liked this post?".

Self-referencing many-to-many works the same way: follows are users ↔ users.

```text
follows(follower_id -> users.id, followee_id -> users.id, created_at)
  PK (follower_id, followee_id)       -- "who do I follow?"
  INDEX (followee_id, follower_id)    -- "who follows me?"
```

## Access patterns first

The single most important habit: **list the queries before you draw the tables.** A model isn't "correct" in the abstract; it's correct for a workload.

Let's model a small photo-sharing app, "Snapgram". Write the access patterns with rough frequencies:

| # | Access pattern | Frequency |
|---|---|---|
| A1 | Show a post with author name, like count, first 20 comments | very high |
| A2 | Show a user's profile grid, newest posts first | high |
| A3 | Home feed: recent posts from people I follow | very high |
| A4 | Like / unlike a post | high (writes) |
| A5 | Has the current user liked this post? | very high |
| A6 | Followers / following lists | medium |
| A7 | Search posts by hashtag | medium |

## The normalized model

```sql
CREATE TABLE users (
  id BIGINT PRIMARY KEY, username TEXT UNIQUE NOT NULL, display_name TEXT, avatar_url TEXT
);
CREATE TABLE posts (
  id BIGINT PRIMARY KEY, author_id BIGINT NOT NULL REFERENCES users(id),
  image_url TEXT NOT NULL, caption TEXT, created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX ON posts (author_id, created_at DESC);                 -- A2

CREATE TABLE comments (
  id BIGINT PRIMARY KEY, post_id BIGINT NOT NULL REFERENCES posts(id),
  author_id BIGINT NOT NULL REFERENCES users(id), body TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX ON comments (post_id, created_at);                     -- A1

CREATE TABLE likes (user_id BIGINT, post_id BIGINT, created_at TIMESTAMPTZ,
                    PRIMARY KEY (user_id, post_id));                -- A4, A5
CREATE TABLE follows (follower_id BIGINT, followee_id BIGINT,
                      PRIMARY KEY (follower_id, followee_id));      -- A3, A6
CREATE TABLE hashtags (tag TEXT, post_id BIGINT, PRIMARY KEY (tag, post_id));  -- A7
```

Notice every index is labelled with the access pattern it serves (Day 21). Hashtags are a join table, not a comma-separated column (1NF).

## Where normalization hurts: denormalize on purpose

**A1 needs a like count.** Normalized: `SELECT COUNT(*) FROM likes WHERE post_id = ?`. For a post with 2 million likes, that's counting 2 million index entries on every view. Instead, store a **counter** on the post:

```sql
ALTER TABLE posts ADD COLUMN like_count INTEGER NOT NULL DEFAULT 0;

-- liking: one atomic statement (PostgreSQL), so the two can't drift (Day 22)
WITH ins AS (
  INSERT INTO likes (user_id, post_id, created_at) VALUES ($1, $2, now())
  ON CONFLICT DO NOTHING                   -- already liked? nothing inserted
  RETURNING post_id
)
UPDATE posts SET like_count = like_count + 1
WHERE id IN (SELECT post_id FROM ins);     -- only bumps if a like was really added
```

The fact "how many likes" is now stored twice (implicitly in `likes`, explicitly in `like_count`). That's the trade: **faster reads, more work and more risk on writes.** If they drift apart, a periodic job can recount. For extremely hot posts, the counter row itself becomes a bottleneck; you'd buffer increments or shard the counter.

**A3, the home feed**, is the big one. Normalized it's a join across `follows` and `posts` sorted by time, recomputed on every app open. The denormalized alternative is a precomputed `feed_items(user_id, post_id, created_at)` table written when a post is created ("fan-out on write"). That's a full design topic of its own (Day 57).

Other common denormalizations:

- Copying `author_username` into each comment so a comment list needs no join (but renames must update all copies, or you accept stale names).
- Storing `follower_count` on users.
- Keeping a read-optimized copy in a search index or cache (Days 29, 37).

**Rule:** normalize by default, then denormalize a specific field for a specific hot access pattern, and write down how the copy stays in sync.

## The same app as documents

In a document database (Day 23) the question becomes **embed or reference?**

```js
// Embed: the post document holds its first comments and a counter
{ _id: "p1", authorId: "u7", authorName: "ana", caption: "Sunset",
  likeCount: 1832,
  recentComments: [ { by: "bo", text: "wow" }, { by: "cy", text: "🔥" } ] }

// Reference: likes live in their own collection
{ _id: "u9:p1", userId: "u9", postId: "p1", at: ISODate("2025-06-01") }
```

| Embed when | Reference when |
|---|---|
| Data is read together with the parent | Data is read on its own too |
| It's bounded (a few items) | It can grow without limit (likes, all comments) |
| It belongs only to this parent | It's shared by many parents (a user is author of many posts) |

Embedding all 2 million likes inside the post would hit MongoDB's 16 MB document limit and make every like rewrite a huge document. Bounded and owned → embed; unbounded or shared → reference.

In key-value stores like DynamoDB, modelers go further and design keys directly for each access pattern (e.g. partition key `USER#7`, sort key `POST#2025-06-01#p1`), so each query is a single partition read. Access patterns first is even more important there because there are no joins to rescue you.

## The math: sizing the likes table

```text
Snapgram: 50 million daily users, each likes 10 posts/day
  likes/day = 50,000,000 × 10 = 500,000,000
  likes/sec = 500,000,000 / 86,400 ≈ 5,800 average (peak maybe 3× ≈ 17,000)

Row: user_id 8 B + post_id 8 B + created_at 8 B = 24 B
  + per-row overhead (~24 B in PostgreSQL) + PK index entry (~24 B) + second index (~24 B)
  ≈ 100 B per like (rough)

  per day  = 500,000,000 × 100 B = 50 GB
  per year = 50 GB × 365 ≈ 18 TB
```

18 TB a year for one table is beyond a comfortable single machine, which tells you early that `likes` will need sharding (Day 32), probably by `post_id` or `user_id` depending on which access pattern dominates. This kind of quick math is exactly what interviewers want to see.

## In an interview

The data model is a required step in every design (Day 55). Interviewers look for: entities and relationships drawn clearly, keys and indexes justified by named queries, conscious denormalization with a sync story, and a sense of size.

> "I'll list the access patterns first: view post, profile grid, home feed, like, has-liked. Core tables are users, posts, comments, likes and follows; likes and follows are join tables with composite primary keys, which also prevents duplicates. Posts are indexed by (author_id, created_at) for profiles. Counting likes on every view is too expensive, so I'll denormalize a like_count on posts, updated in the same transaction as the insert into likes, and reconcile with a periodic recount. At ~500M likes a day the likes table grows ~18 TB a year, so it'll be sharded."

## Common mistakes

- **Designing tables before listing queries.**
- **Lists in a column** (`tags = "a,b,c"`) instead of a join table.
- **Denormalizing everything up front** "for performance" and then fighting inconsistencies.
- **Embedding unbounded arrays** in documents.
- **Forgetting the reverse index** on a join table ("who follows me?" needs `(followee_id, ...)`).
- **No uniqueness constraint**, so double-clicks create duplicate likes.

## Before moving on

- [ ] I can explain update, insert and delete anomalies with an example
- [ ] I can state "the key, the whole key, nothing but the key"
- [ ] I can model one-to-many and many-to-many with the right keys
- [ ] I can justify a denormalized counter and explain how it stays correct
- [ ] I can decide embed vs reference for a document model
- [ ] I can estimate a table's yearly growth

## Go deeper (optional)

- *Designing Data-Intensive Applications*, chapter 2 "Data Models and Query Languages"
- [Wikipedia: Database normalization](https://en.wikipedia.org/wiki/Database_normalization)
- [MongoDB docs: Data Modeling](https://www.mongodb.com/docs/manual/data-modeling/)
- [AWS docs: Best practices for designing and architecting with DynamoDB](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/best-practices.html)
