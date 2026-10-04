# Relational Databases and SQL

> Most of the world's important data (bank balances, orders, users) lives in relational databases, and SQL is how you talk to them. It's a 50-year-old idea that keeps winning. Today you learn to think in tables, write the queries interviews expect, and see what the database does with them.

## The big idea

Think of a **spreadsheet workbook** with strict rules. Each sheet is a **table** about one kind of thing (users, orders). Every column has a fixed type. Every row has a unique ID. And instead of copying a user's name into every order, an order just says "user #7", and you look it up.

That's the **relational model** (Edgar Codd, 1970): data lives in tables, tables point to each other by keys, and you ask questions with a **declarative** language. Declarative means you describe *what* you want ("orders over $100 from Seoul users"), not *how* to find it. The database figures out the how.

## Vocabulary

| Term | Meaning |
|---|---|
| **Table** (relation) | A set of rows with the same columns |
| **Row** (tuple, record) | One item, e.g. one user |
| **Column** (attribute) | One field with a type, e.g. `email TEXT` |
| **Schema** | The definition of tables, columns, types and rules |
| **Primary key (PK)** | Column(s) that uniquely identify a row, never null |
| **Foreign key (FK)** | A column that must match a PK in another table |
| **Constraint** | A rule the DB enforces: `NOT NULL`, `UNIQUE`, `CHECK (price >= 0)` |

## A tiny shop

```sql
CREATE TABLE users (
  id         BIGSERIAL PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  city       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE orders (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id),   -- foreign key
  total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
  status      TEXT NOT NULL DEFAULT 'pending',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Notice `total_cents INTEGER`: money is stored as whole cents, never as a float (remember Day 2's `0.1 + 0.2`).

```text
users                                   orders
id | email          | name  | city      id  | user_id | total_cents | status
1  | ana@x.com      | Ana   | Seoul     10  | 1       | 4500        | paid
2  | bo@x.com       | Bo    | Hanoi     11  | 1       | 12000       | paid
3  | cy@x.com       | Cy    | Seoul     12  | 2       | 800         | pending
```

The foreign key means the DB will **refuse** an order with `user_id = 99` if no user 99 exists. That's **referential integrity**: the database protects your data from your bugs.

## SQL in five moves

**1. Filter and sort**

```sql
SELECT name, email
FROM users
WHERE city = 'Seoul'
ORDER BY created_at DESC
LIMIT 10;
```

**2. Insert, update, delete**

```sql
INSERT INTO orders (user_id, total_cents) VALUES (3, 2500);
UPDATE orders SET status = 'paid' WHERE id = 12;
DELETE FROM orders WHERE status = 'cancelled' AND created_at < now() - interval '1 year';
```

Forgetting `WHERE` on `UPDATE` or `DELETE` changes **every row**. Everyone does it once.

**3. Join tables**

```sql
SELECT u.name, o.id, o.total_cents
FROM orders o
JOIN users u ON u.id = o.user_id
WHERE o.status = 'paid';
```

```text
name | id | total_cents
Ana  | 10 | 4500
Ana  | 11 | 12000
```

An **inner join** (`JOIN`) keeps only pairs that match. A **left join** keeps every row from the left table, filling missing matches with `NULL`. That's the classic way to find "things without other things":

```sql
-- users who have never ordered
SELECT u.name
FROM users u
LEFT JOIN orders o ON o.user_id = u.id
WHERE o.id IS NULL;          -- -> Cy
```

**4. Aggregate**

```sql
SELECT u.city, COUNT(*) AS orders, SUM(o.total_cents) AS revenue
FROM orders o
JOIN users u ON u.id = o.user_id
WHERE o.status = 'paid'
GROUP BY u.city
HAVING SUM(o.total_cents) > 10000
ORDER BY revenue DESC;
```

`GROUP BY` collapses rows into one per group; `COUNT`, `SUM`, `AVG`, `MIN`, `MAX` compute per group. `WHERE` filters rows *before* grouping; `HAVING` filters groups *after*.

**5. Subqueries and CTEs**

```sql
WITH spend AS (
  SELECT user_id, SUM(total_cents) AS total
  FROM orders WHERE status = 'paid' GROUP BY user_id
)
SELECT u.name, s.total
FROM spend s JOIN users u ON u.id = s.user_id
ORDER BY s.total DESC
LIMIT 3;                      -- top 3 customers
```

A `WITH` clause (a **common table expression**) names an intermediate result so the query reads top to bottom.

## The order SQL actually runs in

You write `SELECT ... FROM ... WHERE ...`, but logically the database evaluates:

```text
FROM / JOIN  ->  WHERE  ->  GROUP BY  ->  HAVING  ->  SELECT  ->  ORDER BY  ->  LIMIT
```

That explains puzzles like "why can't I use my `SELECT` alias in `WHERE`?" (the alias doesn't exist yet) and "why does `HAVING` exist?" (`WHERE` runs before groups exist).

## What happens to your query

```text
SQL text -> parser -> query planner/optimizer -> execution plan -> executor -> rows
```

The **planner** considers many ways to run the same query and estimates the cost of each using **statistics** it keeps about tables (row counts, value distributions). Choices include:

- **Scan method:** read the whole table (sequential scan) or use an index (Day 21).
- **Join order:** with 4 tables there are dozens of orders to consider.
- **Join algorithm:**

| Algorithm | How | Good when |
|---|---|---|
| Nested loop | for each row of A, find matches in B (ideally via an index) | one side small, or B indexed on the join key |
| Hash join | build a hash map of the smaller table, stream the bigger one through it | big unsorted tables, equality joins |
| Merge join | sort both by the key, walk them together like a zipper | inputs already sorted (e.g. from an index) |

## The math: why the planner matters

Join 10,000 users with 1,000,000 orders on `user_id`.

```text
Naive nested loop, no index:
  10,000 × 1,000,000 = 10,000,000,000 comparisons   (minutes)

Hash join:
  build map of 10,000 users        ~ 10,000 operations
  probe with 1,000,000 orders      ~ 1,000,000 operations
  total ~ 1,010,000                 (milliseconds)

Nested loop with an index on users.id (B-tree, ~3 levels):
  1,000,000 lookups × ~3 page visits ~ 3,000,000 page visits
```

Same SQL, ~10,000× difference in work. You wrote *what*; the planner picked *how*. You can see its choice with `EXPLAIN` (Day 21).

The same idea in JavaScript:

```js
// hash join: users (small) into a Map, stream orders through it
const byId = new Map(users.map(u => [u.id, u]));
const joined = orders
  .filter(o => byId.has(o.user_id))
  .map(o => ({ name: byId.get(o.user_id).name, total: o.total_cents }));
```

## The N+1 query problem

The most common performance bug in real apps, often caused by ORMs (libraries that map tables to objects):

```js
const orders = await db.query('SELECT * FROM orders LIMIT 50');   // 1 query
for (const o of orders) {
  o.user = await db.query('SELECT * FROM users WHERE id = $1', [o.user_id]); // 50 queries!
}
```

51 round trips. At 1 ms each that's 51 ms instead of ~1 ms. Fix: one `JOIN`, or one `WHERE id = ANY($1)` with all the IDs.

## Why relational is the default

- **Flexible queries:** you don't need to know every question in advance; joins answer new ones.
- **Integrity:** types, keys and constraints stop bad data at the door.
- **Transactions:** move money between two rows all-or-nothing (Day 22).
- **Maturity:** PostgreSQL and MySQL have decades of tooling, backups, replication and people who know them.
- **Scales further than people think:** one well-tuned PostgreSQL server with read replicas (Day 31) handles thousands of transactions per second and terabytes of data.

The usual limits: very high write throughput beyond one machine, schemas that change constantly, or extreme scale where you'd shard (Day 32) or reach for NoSQL (Day 23).

## In an interview

In system design, the safe default is: **"I'll start with a relational database like PostgreSQL unless there's a specific reason not to."** Then name the reason if there is one. Interviewers also ask you to write a query (top-N, join, group by, find missing rows) or to spot an N+1.

> "Relational databases store data in typed tables linked by keys, enforce integrity with constraints, and support transactions and ad-hoc queries through declarative SQL; a cost-based planner turns each query into an execution plan, choosing scan methods, join order and join algorithms from table statistics. For most products with structured, related data it's the right starting point."

## Common mistakes

- **`UPDATE`/`DELETE` without `WHERE`.** Run the `SELECT` with the same `WHERE` first.
- **Storing money as floats.** Use integer cents or `NUMERIC`.
- **`= NULL` instead of `IS NULL`.** `NULL = NULL` is not true in SQL; it's unknown.
- **Building SQL by string concatenation.** Use parameters (`$1`) to avoid SQL injection (Day 48).
- **N+1 queries in a loop.** Batch or join.
- **Thinking `JOIN` is inherently slow.** With indexes and a good plan, joins are what relational DBs are best at.

## Before moving on

- [ ] I can define table, row, primary key, foreign key and constraint
- [ ] I can write a JOIN, a LEFT JOIN for "missing" rows, and a GROUP BY with HAVING
- [ ] I can list the logical order of SQL clauses
- [ ] I can explain nested loop vs hash join with numbers
- [ ] I can spot and fix an N+1 query

## Go deeper (optional)

- [PostgreSQL Tutorial (official docs)](https://www.postgresql.org/docs/current/tutorial.html)
- [SQLBolt interactive lessons](https://sqlbolt.com/)
- [Wikipedia: Relational model](https://en.wikipedia.org/wiki/Relational_model)
- *Designing Data-Intensive Applications*, chapter 2 "Data Models and Query Languages"
