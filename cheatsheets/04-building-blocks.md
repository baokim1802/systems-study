# Building blocks: when to use what

## Load balancer
Spread traffic across servers, remove unhealthy ones. L4 (TCP) is fast and simple; L7 (HTTP) can route by path or header.

## Cache (Redis, Memcached)
Read-heavy data that tolerates being slightly stale. Watch: invalidation, thundering herd, memory size.

## CDN
Static files and media close to users. Cuts latency and origin load.

## Relational DB (Postgres, MySQL)
Default choice. Transactions, joins, constraints. Scale reads with replicas; scale writes with sharding (hard).

## Key-value / wide-column (DynamoDB, Cassandra)
Huge scale, simple access by key, high write throughput. Weak at joins and ad-hoc queries.

## Document DB (MongoDB)
Flexible JSON-like records that are read together.

## Object storage (S3)
Large blobs: images, video, backups. Cheap, durable. Store metadata in a DB, bytes here.

## Message queue / log (SQS, Kafka)
Decouple producers from consumers, absorb spikes, do slow work in the background, retry failures.

## Search index (Elasticsearch)
Full-text search and ranking. Fed from the main DB; not the source of truth.

## Coordination (ZooKeeper, etcd)
Leader election, config, locks. Small data, strong consistency.
