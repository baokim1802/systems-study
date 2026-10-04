# NoSQL Families

> "NoSQL" isn't one thing. It's five quite different families of databases, each built to be extremely good at one shape of data and one kind of question. Knowing which family fits which problem (and when plain PostgreSQL is still the better answer) is a core system design skill.

## The big idea

Think about how you'd store things at home:

- **Key-value**: a coat check. You hand over a ticket number, you get back exactly one coat. Blazing fast, but you can't ask "show me all blue coats".
- **Document**: a folder per customer, with everything about them inside: address, orders, notes. Grab one folder and you have the whole story.
- **Wide-column**: a giant filing cabinet where each drawer (partition) holds one customer's records **already sorted by date**, spread across many cabinets in many rooms.
- **Graph**: a corkboard with photos and strings between them. The strings (relationships) are the point.
- **Time-series**: a weather station's logbook. Numbers with timestamps, arriving forever, mostly read as "the last hour".

A relational database (Day 20) can store all of these, and often should. NoSQL databases exist because at certain scales or shapes, specializing wins.

"NoSQL" originally meant "no SQL", and is now usually read as **"not only SQL"**. Many NoSQL databases even have SQL-like query languages.

## 1. Key-value stores

The interface is basically a JavaScript `Map` over the network:

```js
await kv.set('session:9f2c', JSON.stringify({ userId: 42 }), { EX: 3600 }); // expire in 1 h
const s = await kv.get('session:9f2c');
```

- **Examples:** Redis, Memcached (in-memory); Amazon DynamoDB, etcd, RocksDB (persistent).
- **Good at:** lookups by exact key in well under a millisecond (in-memory). Caching (Day 29), sessions, rate-limit counters (Day 35), feature flags, leaderboards (Redis sorted sets).
- **Bad at:** anything that isn't "by key": searching by value, joins, ad-hoc reports.
- **Scaling:** trivially partitioned by hashing the key (Days 32–33).

Redis keeps everything in RAM and executes commands one at a time on a single main thread, so a single instance commonly does on the order of 100,000+ simple operations per second, and every command is atomic.

## 2. Document databases

Store self-contained **documents**, usually JSON-like, each with its own structure:

```js
{
  _id: "order_9001",
  userId: 42,
  status: "shipped",
  shippingAddress: { city: "Seoul", zip: "04524" },
  items: [
    { sku: "MUG-1", qty: 2, priceCents: 1200 },
    { sku: "TEE-3", qty: 1, priceCents: 2500 }
  ]
}
```

- **Examples:** MongoDB, Couchbase, Firestore, Amazon DocumentDB.
- **Good at:** data that is naturally a **tree** read as a whole (an order with its items, a product with variants, a CMS article). One read, no joins. Fields can vary between documents (**flexible schema**).
- **Bad at:** many-to-many relationships and joins across documents (supported, but clumsy compared to SQL).
- **Limits:** a MongoDB document can be at most 16 MB, so "embed all comments forever" eventually breaks.

"Schemaless" is a myth: your *code* still assumes a shape. It's really **schema-on-read** (the app interprets structure when reading) vs **schema-on-write** (the DB checks structure when writing, like SQL).

## 3. Wide-column stores

The name confuses everyone. Think of it as a **two-level map**: `partition key → (sorted rows by clustering key)`, spread across many machines.

```text
CREATE TABLE messages (
  channel_id  bigint,      -- partition key: decides WHICH machine
  message_id  timeuuid,    -- clustering key: sort order INSIDE the partition
  author_id   bigint,
  body        text,
  PRIMARY KEY ((channel_id), message_id)
) WITH CLUSTERING ORDER BY (message_id DESC);

partition channel 7  -> [msg 1009][msg 1008][msg 1007] ...   (node B)
partition channel 8  -> [msg 2201][msg 2200] ...             (node E)
```

"Latest 50 messages in channel 7" is one partition, already sorted: a single fast sequential read.

- **Examples:** Apache Cassandra, ScyllaDB, HBase, Google Bigtable. (DynamoDB's partition key + sort key works much the same way.)
- **Good at:** **huge write volumes** (they're LSM-based, Day 19), horizontal scale to hundreds of nodes, multi-datacenter replication, queries that always know the partition key. Chat history, activity feeds, IoT readings.
- **Bad at:** queries that don't include the partition key (they hit every node), joins, ad-hoc analytics. You **design one table per query**.
- **Real use:** Discord stored trillions of messages partitioned by channel and time bucket, first on Cassandra and later on ScyllaDB.

## 4. Graph databases

Data is **nodes** (things) and **edges** (relationships), both with properties. Queries follow edges.

```text
(Ana)-[:FOLLOWS]->(Bo)-[:FOLLOWS]->(Cy)
(Ana)-[:LIKES]->(Post 17)<-[:WROTE]-(Cy)

// Cypher (Neo4j): friends-of-friends Ana doesn't follow yet
MATCH (a:User {name:'Ana'})-[:FOLLOWS]->()-[:FOLLOWS]->(fof)
WHERE NOT (a)-[:FOLLOWS]->(fof) AND fof <> a
RETURN fof.name, count(*) AS mutuals ORDER BY mutuals DESC LIMIT 10
```

- **Examples:** Neo4j, Amazon Neptune, JanusGraph.
- **Good at:** many hops through relationships: recommendations, fraud rings ("which accounts share a device with a known fraudster, 3 hops away?"), knowledge graphs, access control graphs.
- **Why not SQL?** Each hop in SQL is another self-join; at 4–6 hops queries get slow and unreadable. Graph DBs store edges so that following one is cheap.
- **Bad at:** bulk aggregate queries over everything, and they're harder to shard (the graph doesn't split cleanly).

## 5. Time-series databases

Data points are `(series, timestamp, value)`, e.g. `cpu{host="web-3"} @ 12:00:05 = 0.73`.

- **Examples:** Prometheus, InfluxDB, TimescaleDB (a PostgreSQL extension), Graphite.
- **Good at:** high-rate appends, range queries by time, downsampling ("1-minute averages for last month"), retention ("delete raw data older than 15 days").
- **Tricks:** store consecutive timestamps and values as **deltas** (differences), which compress dramatically. Facebook's Gorilla paper reported about 1.37 bytes per point instead of 16.
- **Watch out for cardinality:** each unique combination of labels is a separate series. Putting `userId` in a metric label can create millions of series and sink the database.

## The math: sizing a metrics store

```text
10,000 servers × 200 metrics each, scraped every 10 s
  points/sec = 10,000 × 200 / 10 = 200,000 points/s
  points/day = 200,000 × 86,400 = 17,280,000,000 ≈ 1.7 × 10^10

Raw storage (8-byte timestamp + 8-byte float = 16 B):
  1.7 × 10^10 × 16 B ≈ 276 GB/day
Compressed (~1.4 B/point):
  1.7 × 10^10 × 1.4 B ≈ 24 GB/day  -> 15-day retention ≈ 360 GB
```

That's why time-series DBs compress so aggressively: ~11× less disk.

## Side by side

| Family | Data shape | Typical query | Examples | Reach for it when |
|---|---|---|---|---|
| Key-value | opaque value per key | get/set by key | Redis, DynamoDB | caching, sessions, counters |
| Document | JSON tree per entity | fetch/update one entity | MongoDB, Firestore | self-contained entities, evolving fields |
| Wide-column | partition → sorted rows | range within a partition | Cassandra, Bigtable | massive writes, known query patterns |
| Graph | nodes + edges | multi-hop traversal | Neo4j, Neptune | relationships are the product |
| Time-series | timestamped numbers | aggregate over time range | Prometheus, TimescaleDB | metrics, IoT, monitoring |

## SQL vs NoSQL: the honest trade-offs

| | Relational | Typical NoSQL |
|---|---|---|
| Schema | enforced on write | flexible, enforced by your code |
| Queries | ad hoc, joins | designed around known access patterns |
| Transactions | multi-row ACID by default | often per-item or per-partition (many now offer more) |
| Scaling writes | one primary; sharding is manual work | built-in partitioning across nodes |
| Consistency | strong on a single node | often tunable or eventual (Days 39–40) |

The line has blurred: PostgreSQL has `JSONB` columns with indexes (document-like), and MongoDB and DynamoDB support multi-document transactions. "Distributed SQL" databases (Google Spanner, CockroachDB, YugabyteDB) give SQL plus horizontal scaling.

**Default advice:** start relational. Choose a NoSQL family when you can name the reason: a specific access pattern, a write rate or data size beyond one primary, extreme low latency, or data that is truly a graph or time series. Many real systems use several (**polyglot persistence**): PostgreSQL for orders, Redis for sessions, Elasticsearch for search (Day 37), Prometheus for metrics.

## In an interview

The interviewer wants to hear *why*, tied to access patterns and numbers, not brand names.

> "User accounts, orders and payments go in PostgreSQL: relational data, needs transactions. Chat messages are append-heavy, 100k+ writes per second, always read as 'latest N for this conversation', so a wide-column store like Cassandra partitioned by conversation and clustered by message time fits. Sessions and hot counters live in Redis with TTLs. I'm accepting that the message store has no joins and per-partition consistency, which is fine for that query."

## Common mistakes

- **"NoSQL scales, SQL doesn't."** Single PostgreSQL boxes handle a lot; distributed SQL exists; NoSQL scales only if your keys spread load.
- **"Schemaless means no design."** You must model even more carefully around queries (Day 24).
- **Picking MongoDB for highly relational data** and then doing joins in application code.
- **Cassandra queries without the partition key.** Every node gets asked.
- **High-cardinality labels** in a time-series DB.
- **Treating Redis as the only copy** of important data without persistence configured.

## Before moving on

- [ ] I can name the five NoSQL families with one example and one use case each
- [ ] I can explain partition key vs clustering key in a wide-column store
- [ ] I can explain why graph queries are awkward in SQL
- [ ] I can estimate storage for a metrics system
- [ ] I can argue SQL vs NoSQL for a given feature with a concrete reason

## Go deeper (optional)

- *Designing Data-Intensive Applications*, chapter 2 "Data Models and Query Languages"
- [Wikipedia: NoSQL](https://en.wikipedia.org/wiki/NoSQL)
- [Apache Cassandra documentation](https://cassandra.apache.org/doc/latest/)
- [Redis documentation](https://redis.io/docs/latest/)
- [Gorilla: A Fast, Scalable, In-Memory Time Series Database (VLDB 2015)](https://www.vldb.org/pvldb/vol8/p1816-teller.pdf)
