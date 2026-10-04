# Indexes and Query Performance

> The difference between a query that takes 2 seconds and one that takes 2 milliseconds is usually one missing index. Indexes are the single most useful performance tool you have, and they cost something on every write. Today you learn how they work, how to design them, and how to read what the database is doing.

## The big idea

A textbook has an **index** at the back: "Recursion ... pages 42, 118". Without it, finding every mention of recursion means reading all 600 pages. With it, you jump straight there.

A database index is the same: a separate, **sorted** data structure that maps column values to the rows that contain them. Without one, the database does a **full table scan** (reads every row). With one, it walks a B-tree (Day 19) in a handful of steps.

But the book analogy has a catch too: every time the author adds a page, the index at the back must be updated. More indexes, slower writing.

## How an index works

Take `users(id, email, name, city, created_at)` with 100 million rows. The table itself is stored in primary key order (InnoDB) or in an unordered "heap" (PostgreSQL). Searching by email:

```sql
SELECT * FROM users WHERE email = 'ana@x.com';
```

Without an index: read all 100M rows, compare each email. With

```sql
CREATE INDEX idx_users_email ON users(email);
```

the DB builds a B-tree whose keys are emails, sorted, and whose leaves hold a pointer to the row (PostgreSQL: a physical row location; InnoDB: the primary key).

```text
                 [ "g..." | "p..." ]
                /         |         \
     [ "ana@x" ... ]  [ "jo@y" ... ]  [ "sam@z" ... ]   leaves: email -> row pointer
          |
          v
   heap/table row: (17, ana@x.com, Ana, Seoul, ...)
```

Lookup = walk down the tree (3–4 page reads), then fetch the row (1 more).

## The math: `log n` in real life

```text
Full scan of 100,000,000 rows
  ~100 bytes/row -> ~10 GB to read
  at ~1 GB/s sequential -> ~10 seconds

Binary search on sorted data: log2(100,000,000) ≈ 26.6 -> 27 comparisons

B-tree with branching factor ~400:
  400^3 = 64,000,000      (not enough)
  400^4 = 25,600,000,000  (plenty)
  -> about 4 levels; top levels cached in RAM
  -> 1-2 disk reads ≈ 0.1-0.2 ms on an SSD
```

From 10 s to well under 1 ms: roughly **50,000× faster**. And because it's logarithmic, going from 100M to 10B rows adds about one level.

## What an index can and can't help with

A B-tree index is sorted, so it helps anything that benefits from order:

| Query | Uses an index on `email`? |
|---|---|
| `WHERE email = 'a@x.com'` | Yes, point lookup |
| `WHERE email > 'm'` (range) | Yes, find start, walk the leaves |
| `ORDER BY email LIMIT 10` | Yes, already sorted, no sort step |
| `WHERE email LIKE 'ana%'` | Usually yes (it's a prefix range); in PostgreSQL may need `text_pattern_ops` or C collation |
| `WHERE email LIKE '%@gmail.com'` | No, the start is unknown |
| `WHERE LOWER(email) = 'a@x.com'` | No, unless you create an **expression index** on `LOWER(email)` |
| `WHERE email = 123` (type mismatch) | Often no, implicit casts can defeat it |

## Composite indexes and the leftmost-prefix rule

An index can cover several columns: `CREATE INDEX ON orders(user_id, created_at)`. It's sorted by `user_id` first, then by `created_at` *within* each user. Exactly like a phone book sorted by (last name, first name).

```text
(user_id, created_at)
(7, 2025-01-02)
(7, 2025-03-15)
(7, 2025-06-01)
(8, 2024-11-30)
(8, 2025-02-14)
```

| Query | Uses `(user_id, created_at)`? |
|---|---|
| `WHERE user_id = 7` | Yes (leftmost column) |
| `WHERE user_id = 7 AND created_at > '2025-02-01'` | Yes, perfectly: jump to user 7, then a range |
| `WHERE user_id = 7 ORDER BY created_at DESC LIMIT 20` | Yes, already in order: no sort |
| `WHERE created_at > '2025-02-01'` | Not efficiently: dates are scattered across all users |

Like a phone book: easy to find all "Kims", easy to find "Kim, Bao", useless for "everyone named Bao".

**Rule of thumb for column order:** equality columns first, then the range or sort column. `(status, created_at)` serves `WHERE status = 'paid' AND created_at > ...`; `(created_at, status)` mostly doesn't.

## Covering indexes

If the index contains **every column the query needs**, the database never visits the table. That's a **covering index**, and the plan is called an **index-only scan**.

```sql
CREATE INDEX idx_orders_user_date_total ON orders(user_id, created_at, total_cents);
-- or in PostgreSQL: ... ON orders(user_id, created_at) INCLUDE (total_cents);

SELECT created_at, total_cents FROM orders WHERE user_id = 7;   -- index only
```

Saving the extra "fetch the row" read for each of 500 matching rows can turn 500 random reads into a few sequential ones.

## Selectivity: when an index doesn't help

**Selectivity** = the fraction of rows a condition matches. Indexes shine when it's small.

- `WHERE email = ...` → 1 row in 100M. Fantastic.
- `WHERE is_active = true` → 95% of rows. The index would point to almost everything, then each row is a separate random read. Reading the whole table sequentially is cheaper, and the planner will (correctly) ignore the index.

Typical crossover: once a query returns more than a few percent of the table, a sequential scan often wins. That's why indexing a boolean or a `gender` column alone is usually pointless. (A **partial index** like `... WHERE is_active = false` can still help for the rare value.)

## EXPLAIN: asking the database what it did

`EXPLAIN` shows the plan; `EXPLAIN ANALYZE` (PostgreSQL) actually runs it and shows real times.

```text
EXPLAIN ANALYZE SELECT * FROM orders WHERE user_id = 7;

-- before the index:
Seq Scan on orders  (cost=0.00..180000.00 rows=95 width=40)
                    (actual time=0.03..812.4 rows=102 loops=1)
  Filter: (user_id = 7)
  Rows Removed by Filter: 9999898
Execution Time: 812.6 ms

-- after CREATE INDEX ON orders(user_id):
Index Scan using orders_user_id_idx on orders  (cost=0.43..380.1 rows=95 width=40)
                    (actual time=0.02..0.31 rows=102 loops=1)
  Index Cond: (user_id = 7)
Execution Time: 0.35 ms
```

What to look for:

- **Seq Scan** on a big table with a selective filter → probably a missing index. "Rows Removed by Filter: 9,999,898" is the smoking gun.
- **Index Scan / Index Only Scan / Bitmap Index Scan** → index used.
- **Estimated vs actual rows** wildly different → stale statistics; run `ANALYZE`.
- **Sort** with large row counts → maybe an index could provide the order.

MySQL's `EXPLAIN` uses a `type` column instead: `ALL` (full scan, bad) → `index` → `range` → `ref` → `eq_ref` → `const` (best).

## The cost of indexes

Every index is a second (third, fourth...) copy of some columns, kept sorted.

- **Writes get slower.** An `INSERT` into a table with 5 indexes updates 6 structures. An `UPDATE` to an indexed column moves its index entry.
- **Storage grows.** Indexes can easily be 30–100% of the table size.
- **Memory pressure.** Indexes compete for RAM cache; a hot index that doesn't fit in memory is slow.

```text
Table gets 10,000 inserts/s, has 6 secondary indexes.
Each index insert ~ a few random page updates (+ WAL)
-> 10,000 × 7 structures = 70,000 B-tree inserts/s instead of 10,000
```

So: **index for the queries you actually run**, and drop indexes nobody uses (PostgreSQL's `pg_stat_user_indexes` shows usage counts).

## A small JS model

```js
// rows: [{id, userId, total}] ; an "index" is a sorted array of [key, rowPos]
const rows = Array.from({ length: 1_000_000 }, (_, i) => ({ id: i, userId: i % 50_000, total: i % 997 }));
const idx = rows.map((r, pos) => [r.userId, pos]).sort((a, b) => a[0] - b[0]);

function findByUser(userId) {            // binary search for the first match, then walk
  let lo = 0, hi = idx.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (idx[mid][0] < userId) lo = mid + 1; else hi = mid; }
  const out = [];
  for (let i = lo; i < idx.length && idx[i][0] === userId; i++) out.push(rows[idx[i][1]]);
  return out;
}
console.time('scan');  rows.filter(r => r.userId === 4242); console.timeEnd('scan');
console.time('index'); findByUser(4242);                   console.timeEnd('index');
```

The scan touches a million rows; the index does ~20 comparisons plus 20 row fetches. Try it in Node.

## In an interview

You'll hear "this query is slow, what do you do?" or "what indexes would you add for this schema?" Good answers start from the **access pattern** (the actual `WHERE` and `ORDER BY`), propose a specific composite index with the right column order, mention covering, verify with `EXPLAIN ANALYZE`, and acknowledge the write cost.

> "First I'd run `EXPLAIN ANALYZE` to see whether it's a sequential scan and how many rows are filtered out. For `WHERE user_id = ? ORDER BY created_at DESC LIMIT 20` I'd add a composite index on `(user_id, created_at)`: equality column first, then the sort column, so the DB jumps to the user and reads 20 entries in order with no sort. If it only needs a couple of extra columns, I'd include them to make it covering. Each index slows writes and uses memory, so I'd only add indexes that serve real queries."

## Common mistakes

- **Indexing every column separately.** One composite index usually beats three single-column ones for a multi-column filter.
- **Wrong column order** in a composite index (range column first).
- **Wrapping the column in a function** (`WHERE DATE(created_at) = ...`); rewrite as a range or use an expression index.
- **Indexing low-selectivity columns** alone.
- **Forgetting writes.** Write-heavy tables pay for every index.
- **Guessing instead of measuring.** Always confirm with `EXPLAIN ANALYZE`.

## Before moving on

- [ ] I can explain an index with a book analogy and with a B-tree
- [ ] I can compute the depth of a B-tree index for N rows
- [ ] I can apply the leftmost-prefix rule to a composite index
- [ ] I know what a covering index and an index-only scan are
- [ ] I can read a basic `EXPLAIN ANALYZE` and spot a missing index
- [ ] I can explain why indexes slow down writes

## Go deeper (optional)

- [Use The Index, Luke! (Markus Winand)](https://use-the-index-luke.com/)
- [PostgreSQL docs: Indexes](https://www.postgresql.org/docs/current/indexes.html)
- [PostgreSQL docs: Using EXPLAIN](https://www.postgresql.org/docs/current/using-explain.html)
