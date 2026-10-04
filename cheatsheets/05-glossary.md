# Glossary

## Latency vs throughput
Latency: how long one request takes. Throughput: how many requests per second. A highway's speed limit vs its number of lanes.

## Idempotent
Doing it twice has the same effect as once. `PUT x=5` is; `x += 5` isn't. Makes retries safe.

## Stateless service
Keeps no per-user data in its own memory between requests, so any server can handle any request. Easy to scale out.

## Replication
Keeping copies of the same data on several machines, for safety and read scaling.

## Sharding / partitioning
Splitting data across machines so each holds a part. For scaling writes and storage.

## Consistency (strong vs eventual)
Strong: every read sees the latest write. Eventual: replicas catch up after a while; reads may be stale briefly.

## SPOF
Single point of failure: one component whose failure takes down the whole system.

## p99 latency
99% of requests are faster than this. Tail latency matters more than the average.

## Backpressure
Telling a fast producer to slow down when consumers can't keep up.

## TTL
Time to live: how long cached data (or a DNS record) is valid before it must be refreshed.
