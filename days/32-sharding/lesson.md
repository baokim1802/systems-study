# Sharding

> When one database machine can't hold all your data or keep up with all your writes, you split the data into pieces and spread them across many machines. That's sharding: powerful, and the hardest scaling step to undo.

## The big idea

A huge public library has too many books for one building. So it opens several branches. Books by authors A–F go to branch 1, G–M to branch 2, and so on. Each branch is smaller and less crowded, and together they hold everything.

That works great as long as you ask "where is the book by Orwell?". It gets awkward when you ask "show me every book published in 1949": now you must visit every branch. And if one branch gets all the popular authors, it's packed while the others are empty.

**Sharding** (also called **partitioning**) splits a dataset into pieces called **shards** (or **partitions**). Each shard holds a subset of the rows and lives on a different machine (or set of machines). Each row belongs to exactly one shard, chosen by its **shard key** (also called partition key).

Compare with replication (Day 31):

```text
Replication: every node has ALL the data       → more copies   → more reads, survives failures
Sharding:    every node has PART of the data   → more capacity → more writes, more storage
```

In practice you combine them: each shard is itself a small leader + followers group.

```text
             ┌── shard 1 (users 0–24M)   leader + 2 followers
 router ─────┼── shard 2 (users 25–49M)  leader + 2 followers
             ├── shard 3 (users 50–74M)  leader + 2 followers
             └── shard 4 (users 75–99M)  leader + 2 followers
```

## When do you need it?

Sharding is the last resort, not the first move. Scale up, add a cache and read replicas first (Day 27). You shard when:

- **Data size** outgrows one machine (say, tens of terabytes), or
- **Write throughput** outgrows one leader (replicas don't help writes: every write still goes through the single leader), or
- **Working set** (the hot data) no longer fits in one machine's RAM, so everything slows down.

Example estimate (Day 26): 50,000 writes/s at peak, one leader comfortably takes ~10,000/s → you need at least 5 shards, and planning for growth you'd start with more.

## Strategy 1: range partitioning

Each shard owns a **contiguous range** of keys:

```text
shard 1: usernames  a–f
shard 2: usernames  g–m
shard 3: usernames  n–s
shard 4: usernames  t–z
```

- **Pros**: range queries are efficient. "All orders from March 1 to March 7" or "usernames starting with `kim`" touch one or a few shards. Data within a shard stays sorted.
- **Cons**: **hot spots**. If the key is a timestamp, *all* new writes go to the shard holding "now", while the others sit idle. And real data isn't evenly spread: far more names start with "s" than "x". Ranges must be chosen (and re-split) based on the actual data.

Used by: HBase, Bigtable, and range-based sharding in MongoDB and CockroachDB, which **split** a range in two automatically when it grows too big.

## Strategy 2: hash partitioning

Run the key through a hash function (Day 25), and use the hash to pick a shard:

```js
// a simple, deterministic string hash (FNV-1a, 32-bit)
function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

const NUM_SHARDS = 4;
const shardFor = (key) => hash(key) % NUM_SHARDS;

for (const user of ['alice', 'bob', 'carol', 'dave', 'erin', 'frank']) {
  console.log(user, '→ shard', shardFor(user));
}
```

- **Pros**: a good hash spreads keys evenly, even if the keys themselves are clustered (sequential IDs, timestamps, names starting with "s"). No hand-tuned ranges.
- **Cons**: **range queries are gone**. Neighboring keys land on random shards, so "users created this week" must ask every shard.

**The `% N` trap.** If you go from 4 shards to 5, `hash(key) % 5` differs from `hash(key) % 4` for about **80%** of keys, so nearly all data must move at once. That's terrible. The fixes are below, and Day 33 (consistent hashing) is entirely about this problem.

### Compound keys: the best of both

Many databases let you hash one part of the key and sort by another. Cassandra, for example, uses a **partition key** (hashed, picks the shard) and **clustering columns** (sorted inside the partition):

```text
PRIMARY KEY ((user_id), created_at)
  user_id     → hashed → decides which node
  created_at  → sorted within that user's partition → "latest 20 posts by user 42" is one fast read
```

## Hot spots and skew

Even with hashing, one key can be too hot. If a celebrity with 100 million followers posts, every read and like of that post goes to the shard holding it. Hashing spreads *keys*, not *traffic on a single key*.

Fixes:

- **Split the hot key**: append a small random suffix (`post123#0` … `post123#9`) so writes spread across 10 shards; reads then gather from all 10 and combine. Use it only for the few keys that need it.
- **Cache** the hot item aggressively (Day 29).
- **Detect** skew with per-shard metrics; one shard at 90% CPU while the others sit at 20% is a classic sign.

## Rebalancing: adding shards without moving everything

Data grows, so you'll add machines. Good approaches:

1. **Many fixed partitions (logical shards).** Create far more partitions than machines from day one, say **1,024 partitions on 8 machines** (128 each). The key-to-partition mapping (`hash % 1024`) **never changes**. Adding a 9th machine just moves some whole partitions to it. Only about `1/9` of the data moves. Used by Elasticsearch, Riak, Couchbase and many in-house systems.
2. **Dynamic splitting.** Start with few ranges and split any range that grows too big (HBase, MongoDB, CockroachDB).
3. **Consistent hashing.** Arrange shards on a ring so adding a node moves only about `1/N` of keys (Day 33).

```text
Keys moved when going from 8 to 9 machines:
  hash % N              → ~8/9 ≈ 89% of keys move
  fixed 1,024 partitions → ~1/9 ≈ 11% of keys move (whole partitions are reassigned)
```

Moving data is slow and risky, so it's done gradually, in the background, often with a human approving the plan.

## Routing: how does a request find its shard?

Someone must know the **mapping** from key to shard to machine:

- **A routing tier** (proxy) that clients talk to, like `mongos` for MongoDB or Vitess's VTGate for MySQL.
- **Client-side routing**: the client library knows the mapping and connects directly.
- **Any node forwards**: the client contacts any node, which forwards the request if needed (Cassandra).

The mapping itself is often kept in a coordination service like ZooKeeper or etcd (Day 42), so everyone agrees on it.

## Cross-shard queries and transactions

Sharding makes some things that were easy on one database hard:

- **Queries not using the shard key** must go to every shard and combine results (**scatter-gather**). Latency is set by the slowest shard, and load multiplies with shard count.
- **Joins** between tables on different shards are expensive. Co-locate related data: put a user's orders on the same shard as the user (shard both tables by `user_id`).
- **Secondary indexes** (e.g. look up a user by email when sharded by `user_id`) are either **local** (each shard indexes its own rows, so lookups scatter) or **global** (a separate index, itself sharded by email, which must be updated on every write).
- **Transactions across shards** need distributed transactions (Day 44), which are slow and complex. Design so most transactions stay within one shard.
- **Unique IDs**: auto-increment per shard collides. Use UUIDs or an ID scheme like Snowflake (Day 56).

## Choosing a shard key

The most important decision. A good shard key:

1. **Has high cardinality**: many distinct values (millions of user IDs, not 3 country codes).
2. **Spreads load evenly**: no single value gets a huge share of traffic.
3. **Matches the main access pattern**: the most frequent queries include it, so they hit one shard.
4. **Keeps related data together**: things often read or updated together share a shard.

| App | Good shard key | Why | Bad choice |
|---|---|---|---|
| Chat app | `conversation_id` | Messages of a chat are read together | `message_id` (a chat's history scatters) |
| SaaS for companies | `tenant_id` | Each customer's data stays on one shard | `created_at` (hot spot on "today") |
| Social posts | `user_id` | "Posts by user X" is one shard | `country` (low cardinality, very skewed) |
| IoT sensor data | `(sensor_id, day)` | Spreads writes, keeps a day of readings together | `timestamp` alone |

Watch the SaaS case: if one tenant is 1,000× bigger than the rest, `tenant_id` makes a hot shard. Big tenants may need their own dedicated shards.

## In an interview

When your estimates show more data or writes than one machine can handle, say so and shard. Interviewers listen for:

- **Why** you need it, backed by numbers.
- **The shard key** and how it matches the access patterns.
- **Hash vs range** and the trade-off (even spread vs range queries).
- **Hot spots** and how you'd handle a celebrity or a giant tenant.
- **Rebalancing** without moving everything (fixed partitions or consistent hashing).
- **Cross-shard** operations you've avoided, or how you'd handle them.

Sample answer: *"At 2 billion messages a day we're at ~25k writes/s and ~1 TB/day, beyond a single leader. I'd shard messages by `conversation_id` using hashing over 4,096 fixed partitions, so loading a conversation's history hits one shard and adding machines only moves whole partitions. Each shard is replicated three ways. Listing a user's conversations is a different access pattern, so I'd keep a separate table sharded by `user_id`."*

## Common mistakes

- **Sharding too early.** It adds huge complexity; a single well-tuned database goes a long way.
- **Using `hash % N` with N = number of machines.** Adding a machine reshuffles almost everything.
- **Sharding by time** for write-heavy data: all writes hit the newest shard.
- **Low-cardinality keys** (country, status): you can never have more shards than distinct values.
- **Forgetting the queries that don't include the shard key** and end up hitting every shard.

## Before moving on

- [ ] I can explain the difference between sharding and replication
- [ ] I can compare range and hash partitioning
- [ ] I can explain why `hash % N` is painful to resize and how fixed partitions help
- [ ] I can choose and defend a shard key for a given app
- [ ] I can explain scatter-gather and why cross-shard transactions are costly

## Go deeper (optional)

- *Designing Data-Intensive Applications*, chapter 6 ("Partitioning")
- [Shard (database architecture) on Wikipedia](https://en.wikipedia.org/wiki/Shard_(database_architecture))
- [Vitess documentation](https://vitess.io/docs/), sharding for MySQL used at YouTube
- Chang et al., "Bigtable: A Distributed Storage System for Structured Data" (2006)
