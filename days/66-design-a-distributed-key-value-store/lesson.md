# Design a Distributed Key-Value Store

> This is the capstone of the distributed-systems days. Amazon's Dynamo paper (2007) described a store that stayed writable through failures, and its ideas live on in Cassandra, Riak and DynamoDB. Designing one pulls together consistent hashing, replication, quorums, vector clocks, gossip and LSM trees: a guided tour of Days 19–43.

## The big idea

Imagine a city-wide network of lockers where anyone can store a box under a name and fetch it later. No single building could hold every box or survive a fire, so:

- The names are spread over many buildings by a **rule everyone can compute** (consistent hashing): no central directory needed.
- Each box is copied into **3 buildings** (replication), so one fire loses nothing.
- To store or fetch, you don't wait for all 3 buildings, just **enough of them** (a quorum), so one slow building doesn't block you.
- If a building is closed, a neighbor holds the box with a **sticky note** ("give this to building 5 when it reopens"): hinted handoff.
- Buildings **gossip** with each other to learn who is open, and periodically **compare inventories** cheaply (Merkle trees) to fix differences.
- If two people updated the same box at the same time in different buildings, the box carries a **version history** (vector clock) so the conflict can be detected rather than silently lost.

## Step 1: Clarify requirements

**Functional**

- `put(key, value)` and `get(key)`; keys up to ~256 B, values up to ~10 KB.
- (Optional) `delete(key)`.

**Non-functional**

- **Always writable:** accept writes even during node failures or network partitions (an AP system in CAP terms, Day 39).
- **Tunable consistency:** callers can trade latency for stronger reads.
- **Scalable:** add nodes to grow storage and throughput linearly, with minimal data movement.
- **Low latency:** p99 under ~10 ms within a data center.
- **Durable:** no acknowledged write is lost.

## Step 2: Back-of-the-envelope estimates

```text
Keys                        10 billion × 1 KB average = 10 TB of data
Replication factor N = 3    30 TB stored
Per node: 4 TB SSD, keep ≤ 50% full for compaction and rebalancing → 2 TB usable
Nodes for storage           30 TB / 2 TB = 15 nodes

Traffic                     500k reads/s + 200k writes/s
Replica operations          reads hit R = 2 replicas → 1.0M; writes hit all N = 3 → 0.6M
                            total ≈ 1.6M replica ops/s
One node handles            ~50k ops/s
Nodes for throughput        1.6M / 50k = 32 nodes
```

Throughput, not storage, decides: plan **~40 nodes** with headroom for failures. With virtual nodes each server owns many small ranges, so adding the 41st takes a small slice from everyone.

## Step 3: API

```text
get(key)                    → { values: [v1, v2?], context }   more than one value = conflict siblings
put(key, value, context)    context = the vector clock you read, so the store knows what you've seen
delete(key, context)        writes a tombstone

Per-request knobs (DynamoDB / Cassandra style): consistency = ONE | QUORUM | ALL
```

## Step 4: Data model (on each node)

Each node stores its key ranges in an **LSM tree** (Day 19):

```text
write → commit log (append, fsync) → memtable (sorted, in RAM) → flushed to SSTables on disk
read  → memtable → SSTables newest to oldest (a Bloom filter per SSTable skips files, Day 25)
background compaction merges SSTables and drops overwritten values and old tombstones
```

LSM trees turn random writes into sequential appends (Day 8), which is why write-heavy stores choose them. Each stored value carries its vector clock.

## Step 5: High-level design

```text
                         hash ring (0 … 2^128), many virtual nodes per server
                    ┌────────────────────────────────────────────┐
  client ──put(k)──▶│ any node = coordinator for this request     │
                    │  1. hash(k) → position on ring              │
                    │  2. preference list = next N distinct nodes │
                    │  3. send to all N, wait for W acks          │
                    └───────┬──────────────┬──────────────┬──────┘
                            ▼              ▼              ▼
                         node B         node C         node D      (replicas of k)
                            ▲  gossip: membership + heartbeats every second  ▲
                            └─────────── anti-entropy with Merkle trees ─────┘
```

Every node is equal: there's no master. Any node can coordinate any request because every node knows the ring (learned by gossip).

## Step 6: Deep dives

### Partitioning: consistent hashing with virtual nodes

`hash(key) % numberOfNodes` reshuffles almost every key when a node joins (Day 33). On a **ring**, a key belongs to the first node clockwise from its hash, so adding a node only moves the keys between it and its predecessor: about `1/n` of the data. Giving each physical server ~100–256 **virtual nodes** spreads load evenly and lets a new server take small slices from many others at once.

### Replication: the preference list

The key's coordinator stores it and the next `N - 1` **distinct physical** servers clockwise (skip virtual nodes that belong to a server already chosen). Rack- or zone-aware placement puts the 3 replicas in different availability zones (Day 51).

### Quorums: N, R, W

- **N** = replicas per key, **W** = acks needed for a write, **R** = replies needed for a read.
- If `R + W > N`, every read set overlaps every write set in at least one replica, so a read sees the latest acknowledged write (Day 40), ignoring edge cases like sloppy quorums.

| Setting (N = 3) | Behavior |
|---|---|
| W = 2, R = 2 | balanced, overlap guaranteed, tolerates 1 slow/dead replica |
| W = 1, R = 3 | very fast writes, slow reads |
| W = 3, R = 1 | fast reads, writes fail if any replica is down |
| W = 1, R = 1 | fastest, eventual consistency only |

The math of availability: if each replica is up 99% of the time, independently:

```text
P(write succeeds with W = 3) = 0.99^3                            = 0.9703   (97.0%)
P(write succeeds with W = 2) = 0.99^3 + 3 × 0.99^2 × 0.01        = 0.9997   (99.97%)
P(write succeeds with W = 1) = 1 - 0.01^3                         = 0.999999
```

Requiring all 3 replicas turns three 99% machines into a 97% system, worse than one machine (Day 45's serial availability). Quorums keep you fast and available.

### Sloppy quorum and hinted handoff

If replica D is down, the coordinator writes D's copy to the next healthy node E **with a hint**: "this belongs to D." When gossip shows D is back, E hands the data over and deletes it. Writes stay available through short failures. The catch: during that time, `R + W > N` no longer guarantees overlap with the *intended* replicas, which is why it's called sloppy.

### Conflicts: vector clocks

During a partition, two clients may update the same key on different replicas. Timestamps can't be trusted to order them (Day 41). A **vector clock** is a map `{ nodeId: counter }` attached to each value. Compare two clocks:

- every counter in A ≤ B's (and they differ) → **A happened before B**: keep B.
- some counters bigger on each side → **concurrent**: keep both as **siblings** and let the client (or a merge rule) resolve them.

```js
function compareClocks(a, b) {
  let aBigger = false, bBigger = false;
  for (const node of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[node] ?? 0, y = b[node] ?? 0;
    if (x > y) aBigger = true;
    if (y > x) bBigger = true;
  }
  if (aBigger && bBigger) return "concurrent";
  if (aBigger) return "a-after-b";
  if (bBigger) return "b-after-a";
  return "equal";
}

console.log(compareClocks({ A: 2, B: 1 }, { A: 1, B: 1 }));  // "a-after-b": keep a
console.log(compareClocks({ A: 2, B: 1 }, { A: 1, B: 2 }));  // "concurrent": siblings
```

Dynamo's famous example: a shopping cart. If two concurrent versions exist, merging them (union of items) means an added item is never lost, though a deleted item can occasionally reappear. Many systems choose the simpler **last-write-wins** (by timestamp) instead, accepting that concurrent writes silently drop one value. Good for caches, bad for carts.

### Read repair and anti-entropy with Merkle trees

When a read collects R replies and one is stale, the coordinator writes the newest version back to it: **read repair**. But keys nobody reads never get repaired, so nodes also run background **anti-entropy**.

Comparing 1 million keys one by one between two replicas means sending 1 million hashes. A **Merkle tree** hashes keys into buckets, then hashes pairs of hashes up to one root:

```text
                root = h(h12, h34)
              /                   \
        h12 = h(h1,h2)        h34 = h(h3,h4)
         /       \              /       \
      h1(bucket1) h2(...)   h3(...)    h4(...)
```

If the roots match, the replicas are identical: done with **one** hash comparison. If not, descend only into subtrees that differ. With 1M keys in 1,024 buckets of ~1,000 keys, the tree is `log2(1024) = 10` levels deep; if a single bucket differs, you compare about 2 hashes per level (~20) and then sync ~1,000 keys instead of 1,000,000.

### Membership and failure detection: gossip

No central registry: every second each node picks a random peer and exchanges its membership list with heartbeat counters. News spreads like a rumor: about `log2(N)` rounds reach everyone, so a 1,000-node cluster learns of a change in roughly 10+ rounds, a few seconds. A node whose heartbeat hasn't increased for a while is suspected down (Cassandra uses a smarter "phi accrual" detector that adapts to network jitter).

### Deletes and tombstones

You can't simply remove a key: a replica that missed the delete would "resurrect" it during repair. Instead write a **tombstone** (a deletion marker with a clock), and garbage-collect it only after it has surely reached every replica (e.g. after 10 days in Cassandra by default).

## Step 7: Bottlenecks and trade-offs

| Choice | Gives | Costs |
|---|---|---|
| Leaderless + quorums | always writable, no failover | conflicts, read repair, weaker guarantees |
| Vector clocks + siblings | no lost concurrent writes | clients must merge; clocks grow |
| Last-write-wins | simple | silently drops concurrent writes, depends on clocks |
| Sloppy quorum | availability during failures | temporary staleness |
| LSM storage | fast writes | compaction I/O, read amplification |

A **hot key** (one celebrity's profile) still lands on just N replicas: cache it, or split it into sub-keys.

## In an interview

Interviewers expect you to assemble the building blocks with reasons: consistent hashing with vnodes, N/R/W with the overlap argument, hinted handoff, vector clocks or LWW with trade-offs, Merkle-tree anti-entropy, gossip, and an LSM storage engine. Model summary:

> "Keys are placed on a consistent-hash ring with virtual nodes and replicated to the next three distinct servers across zones. Any node coordinates a request; with N = 3, W = 2, R = 2, reads overlap writes and one replica can be down. If a replica is unreachable, a neighbor accepts the write with a hint and hands it off later. Values carry vector clocks so concurrent writes become siblings rather than being lost; read repair and Merkle-tree anti-entropy fix divergence; gossip spreads membership. Each node stores data in an LSM tree with a commit log for durability."

## Common mistakes

- **Saying `R + W > N` means linearizable.** Sloppy quorums, concurrent writes and failed partial writes all break that (Day 40).
- **Using wall-clock timestamps to resolve conflicts** without admitting it loses writes.
- **Placing replicas on virtual nodes of the same physical server.**
- **Deleting keys outright** and watching them come back during repair.
- **Requiring W = N for safety**, which makes writes less available than a single node.

## Before moving on

- [ ] I can explain how a key finds its replicas on the ring, including virtual nodes
- [ ] I can compute availability for different W values and explain R + W > N
- [ ] I can compare two vector clocks and explain siblings vs last-write-wins
- [ ] I can explain hinted handoff, read repair and Merkle-tree anti-entropy
- [ ] I can estimate the number of nodes from storage and throughput

## Go deeper (optional)

- DeCandia et al., *Dynamo: Amazon's Highly Available Key-value Store* (SOSP 2007)
- Lakshman and Malik, *Cassandra: A Decentralized Structured Storage System* (2010)
- [Merkle tree on Wikipedia](https://en.wikipedia.org/wiki/Merkle_tree)
- [Vector clock on Wikipedia](https://en.wikipedia.org/wiki/Vector_clock)
- *Designing Data-Intensive Applications*, chapter 5 (leaderless replication) and chapter 6 (partitioning)
