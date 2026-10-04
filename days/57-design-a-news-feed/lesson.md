# Design a News Feed

> Facebook's News Feed, the Twitter/X timeline, Instagram's home screen: you open the app and instantly see fresh posts from hundreds of people you follow. The core puzzle, "do the work when someone posts, or when someone reads?", is one of the most famous trade-offs in system design. We'll solve it with the Day 55 framework.

## The big idea

Imagine a small town where everyone wants to hear the news from their friends.

- **Option 1, the newspaper boy (push):** when anyone writes news, a courier immediately copies it into the mailbox of every friend. Reading is instant: open your mailbox. But when the mayor, who has 50,000 "friends", writes something, the courier must stuff 50,000 mailboxes.
- **Option 2, the bulletin boards (pull):** everyone pins their news on their own board. To read, you walk around to the boards of all 300 people you follow and collect what's new. Writing is instant; reading is a long walk.

Real feeds use **both**: push for ordinary people, pull for the mayor. Getting there, and explaining why, is the interview.

## Step 1: Requirements (5 min)

Questions to ask: Is the feed chronological or ranked? Text only, or media? Following (one-way, like Twitter) or friends (two-way, like Facebook)? How fresh must it be?

**Functional**

1. A user can publish a post (text plus optional images/video links).
2. A user can view their home feed: posts from accounts they follow, newest or best first, paginated (infinite scroll).
3. Users follow/unfollow others.

Out of scope: comments, likes UI, notifications, ads, search (mention them, don't design them).

**Non-functional**

- 200M daily active users (DAU).
- Feed loads **fast**: p99 under ~200 ms for the first page.
- Highly available; **eventual consistency is fine**: a post may take a few seconds to appear in followers' feeds.
- Follower counts are very skewed: most users have ~200 followers, some celebrities have 100M+.

## Step 2: Estimates (5 min)

```text
feed reads:  200M DAU × 10 opens/day = 2B/day ÷ 86,400 ≈ 23,000/s    peak ×3 ≈ 70,000/s
posts:       200M × 0.5 posts/day    = 100M/day ÷ 86,400 ≈ 1,160/s   peak ≈ 3,500/s
fan-out:     1,160 posts/s × 200 followers (avg) ≈ 230,000 feed inserts/s
celebrity:   one post × 100M followers = 100M inserts for a single post
post storage: 100M/day × ~1 KB metadata/text = 100 GB/day ≈ 36 TB/year (media in object storage + CDN)
```

The numbers frame the whole design: **reads are 20x posts** and must be fast, which favors precomputing feeds. But the fan-out multiplies writes by 200 on average, and by 100 million in the worst case.

## Step 3: API (5 min)

```text
POST /v1/posts                       { text, mediaIds? }      → 201 { postId }
GET  /v1/feed?cursor=<postId>&limit=20                      → 200 { posts: [...], nextCursor }
POST /v1/users/{id}/follow           DELETE /v1/users/{id}/follow
```

Pagination uses a **cursor**, not `?page=3` offsets (Day 17). Feeds change constantly: with offsets, a new post at the top shifts everything down and the user sees duplicates. A cursor says "give me posts *older than* post X", which stays correct as new posts arrive.

## Step 4: Data model (5 min)

```text
posts        post_id (Snowflake, Day 56: time-sortable) PK, author_id, text, media_urls, created_at
             access: get by id (batch), get by author newest-first  → partition by author_id

follows      (follower_id, followee_id), created_at
             access: "who follows X?" (fan-out) and "whom does X follow?" (pull, display)
             → store both directions, each partitioned by its first id

feed cache   user_id → list of post_ids, newest first, capped at ~500
             access: read the first N for a user → Redis list or sorted set, sharded by user_id
```

Using **Snowflake IDs** for posts means sorting by ID is sorting by time, which makes merging and cursors simple.

Note the feed stores **IDs only**, not full posts. A post is stored once; the feed has 8-byte pointers. "Hydration" (fetching post bodies, author names, like counts) happens at read time from caches.

## Step 5: High-level design (10 min)

```text
 POST /posts
     │
     ▼
 ┌──────────────┐   store   ┌───────────┐
 │ Post service │──────────►│ Posts DB  │
 └──────┬───────┘           └───────────┘
        │ "post created" event
        ▼
 ┌──────────────┐  ┌────────────────┐  for each follower:   ┌──────────────┐
 │ Queue (Kafka)│─►│ Fan-out workers│─ LPUSH + LTRIM ──────►│ Feed cache   │
 └──────────────┘  └───────┬────────┘                       │ (Redis,      │
                           │ who follows author?            │  by user_id) │
                           ▼                                └──────▲───────┘
                    ┌──────────────┐                               │
                    │ Follow graph │                               │
                    └──────────────┘                               │
 GET /feed ──► LB ──► ┌──────────────┐  1. read ids ───────────────┘
                      │ Feed service │  2. merge celebrity posts (pull)
                      └──────┬───────┘  3. hydrate: post cache + user cache
                             └────────► 4. rank, paginate, return
```

Walk through it:

- **Publish:** store the post, return 201 right away, and emit an event. Fan-out happens **asynchronously** in workers, so posting stays fast even with many followers.
- **Fan-out:** a worker looks up the author's followers and pushes the post ID onto each follower's cached feed list, trimming it to the newest ~500.
- **Read:** the feed service reads the user's ID list, merges in posts from followed celebrities, fetches the post bodies (mostly from a post cache), and returns a page.

## Step 6: Deep dives (12 min)

### Deep dive 1: fan-out on write vs fan-out on read

| | Fan-out on write (push) | Fan-out on read (pull) |
|---|---|---|
| Work happens | when a post is made | when a feed is opened |
| Feed read | one cache lookup: fast | query every followee, merge: slow |
| Post write | N inserts for N followers | one insert |
| Celebrity with 100M followers | 100M inserts per post: hours of backlog | no problem |
| Inactive users | wasted work filling feeds nobody reads | no wasted work |
| Freshness | slight delay while fan-out runs | always current |

The numbers make it concrete. Pure pull: 70,000 feed reads/s × 200 followees = **14 million** timeline lookups per second. Pure push: one celebrity post at, say, 1 million inserts/s of fan-out capacity takes **100 seconds** and delays everyone else's posts in the queue.

**The hybrid** (what Twitter and Facebook-style systems describe):

- Normal authors (followers below a threshold, e.g. ~10k–100k): **push** to followers' feeds.
- Celebrities: **don't fan out**. Their posts stay in their own timeline. At read time, the feed service fetches recent posts from the handful of celebrities the user follows and merges them in.
- Skip fan-out to users inactive for, say, 30 days; rebuild their feed with pull when they return.

The merge is the "merge k sorted lists" problem, done with a cursor:

```js
// Post ids are Snowflake-style: bigger id = newer post (Day 56).
// pushed:   ids already fanned out into this user's feed cache (newest first)
// celebLists: for each followed celebrity, their recent post ids (newest first)
function readFeed(pushed, celebLists, cursor = Infinity, limit = 5) {
  const all = [pushed, ...celebLists];
  const pos = all.map(() => 0);
  const page = [];
  while (page.length < limit) {
    let best = -1;
    for (let i = 0; i < all.length; i++) {
      // skip anything at or above the cursor (already shown)
      while (pos[i] < all[i].length && all[i][pos[i]] >= cursor) pos[i]++;
      if (pos[i] < all[i].length &&
          (best === -1 || all[i][pos[i]] > all[best][pos[best]])) best = i;
    }
    if (best === -1) break;                       // every list is exhausted
    page.push(all[best][pos[best]++]);
  }
  const nextCursor = page.length ? page[page.length - 1] : null;
  return { page, nextCursor };
}

const pushed = [990, 970, 940, 900, 850];   // from friends, via fan-out on write
const taylor = [985, 930];                  // a celebrity, pulled at read time
const nasa   = [960, 880];
const first = readFeed(pushed, [taylor, nasa]);
console.log(first);  // { page: [990, 985, 970, 960, 940], nextCursor: 940 }
console.log(readFeed(pushed, [taylor, nasa], first.nextCursor));
// { page: [930, 900, 880, 850], nextCursor: 850 }
```

With `k` lists this scan is `O(limit × k)`; with many lists you'd use a heap (`O(limit × log k)`), but users typically follow only a few celebrities.

### Deep dive 2: feed storage size

```text
200M users × 500 post ids × 8 bytes = 800 GB  (plus Redis overhead, maybe ~2x)
```

That doesn't fit on one machine, but it fits easily in a Redis cluster of tens of nodes, sharded by `user_id` (consistent hashing, Day 33). Keep only ~500 IDs per user: almost nobody scrolls further, and older pages can fall back to pull. Replicate each shard; if the cache is lost, feeds can be **rebuilt** from the posts DB and follow graph (slowly), so the cache is not the source of truth.

### Deep dive 3: ranking

A chronological feed is simple. A ranked feed ("top posts first") is a pipeline:

1. **Candidate generation:** gather a few hundred to a few thousand recent post IDs (exactly the pushed + pulled lists above).
2. **Scoring:** compute a score for each from features: how close the reader is to the author (**affinity**: do they interact?), engagement (likes, comments), post type, and age.
3. **Re-ranking and filtering:** remove duplicates and blocked content, diversify (not five posts in a row from one person), then return the top N.

A toy score (big platforms use machine-learned models, but the shape is the same):

```js
function score(post, nowMs) {
  const ageHours = (nowMs - post.createdAt) / 3_600_000;
  const engagement = 1 + post.likes + 3 * post.comments;   // comments count more
  return (post.affinity * engagement) / Math.pow(ageHours + 2, 1.5);
}
// With affinity 0.9 vs 0.2:
// 4.13  acquaintance, 3h ago, 200 likes
// 1.39  best friend, 1h ago, 4 likes
// 1.20  acquaintance, 20h ago, 500 likes
```

The `(age + 2)^1.5` term is a **time decay**, similar in spirit to Hacker News' ranking: old posts sink even with lots of likes. Ranking breaks simple ID cursors (scores change between page loads), so ranked feeds usually rank once per session and paginate through that saved order.

## Step 7: Wrap-up (3 min)

- **Bottlenecks:** fan-out workers during peaks (scale them horizontally from the queue; Kafka partitions let us add consumers, Day 34). Celebrity reads: cache their recent posts aggressively, since millions of feeds pull the same lists.
- **Failures:** a fan-out backlog only delays feeds (eventual consistency was accepted); a lost cache shard is rebuilt from source data; the post itself is durable before we return 201.
- **Deletes and privacy:** a deleted post may still be in millions of feed lists. Filter at hydration time (the post lookup returns "deleted"), rather than chasing every copy.
- **Monitoring:** feed p99 latency, fan-out queue lag (time from post to appearing in feeds), cache hit rate.
- **At 10x:** tune the celebrity threshold, more cache shards, regional feed caches for global users.

## Common mistakes

- **Pure push without the celebrity problem.** Interviewers will ask "what if Taylor Swift posts?" Have the hybrid ready.
- **Storing full posts in every feed.** Store IDs; hydrate at read time.
- **Offset pagination** on a constantly changing list.
- **Synchronous fan-out** inside the POST request.
- **Forgetting inactive users**, who can be most of the fan-out work for no benefit.

## Before moving on

- [ ] I can compute read QPS, post QPS and fan-out inserts/s from DAU
- [ ] I can compare push vs pull and explain the hybrid with a threshold
- [ ] I can write the cursor-based merge of pushed and pulled lists
- [ ] I can size the feed cache (800 GB for 200M users)
- [ ] I can describe a ranking pipeline: candidates, scoring, re-ranking

## Go deeper (optional)

- [News feed (Wikipedia)](https://en.wikipedia.org/wiki/News_feed)
- *Designing Data-Intensive Applications*, chapter 1, which uses Twitter's home timeline as its running example of fan-out
- *System Design Interview – An Insider's Guide*, Volume 1, by Alex Xu (news feed chapter)
