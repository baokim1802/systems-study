# The Data Structures Behind Databases

> A database is "just" a program that stores bytes in files and finds them again quickly. Two data structures, the B-tree and the LSM tree, run almost every database you'll ever touch. Understanding them explains why some databases are great at writes, others at reads, and what "write amplification" means in an interview.

## The big idea

Picture a **diary**. Writing is super fast: you just add a line at the end. But finding "what did I write about Sam?" means reading the whole thing. Now picture a **dictionary**. Finding a word is fast because it's sorted, but adding a new word means squeezing it into the right page.

Every storage engine (the part of a database that actually writes to disk) is a trade-off between those two: **fast writes (append) vs fast reads (sorted, indexed)**. The clever designs get most of both.

## Step 1: the simplest database in the world

```js
import fs from 'node:fs';

function set(key, value) {
  fs.appendFileSync('db.log', JSON.stringify([key, value]) + '\n');
}
function get(key) {
  let result;
  for (const line of fs.readFileSync('db.log', 'utf8').split('\n')) {
    if (!line) continue;
    const [k, v] = JSON.parse(line);
    if (k === key) result = v;          // last write wins
  }
  return result;
}
```

This is an **append-only log**: a file you only ever add to the end of. Updating a key just appends a newer line; the latest one wins.

- **Writes are excellent.** Appending is *sequential I/O*, the fastest thing a disk does (Day 8).
- **Reads are terrible.** `get` scans the whole file: `O(n)`. At 10 GB that's seconds per lookup.

Real databases keep the log idea (it's also how crash recovery works, Day 22) but add an **index**: an extra structure that tells you where data lives.

## Step 2: a hash index

Keep an in-memory hash map (Day 25) from key to the **byte offset** where its latest value starts in the file.

```text
In memory (Map)              On disk: db.log
"cat" -> 0                   0:  ["cat","meow"]
"dog" -> 16                  16: ["dog","woof"]
                             32: ["cat","purr"]    <- "cat" now -> 32
```

```js
const index = new Map();
let offset = 0;
function set(key, value) {
  const line = JSON.stringify([key, value]) + '\n';
  fs.appendFileSync('db.log', line);
  index.set(key, offset);
  offset += Buffer.byteLength(line);
}
// get(key): look up offset, read just that one line -> one disk seek
```

Now writes are one append and reads are one seek. This is essentially how **Bitcask** (the engine in the Riak database) works.

Two problems remain:

1. **The file grows forever.** Old values of "cat" are garbage. Fix: split the log into **segments** (e.g. 64 MB files). When a segment is closed, run **compaction**: rewrite it keeping only the latest value per key, and merge small segments together. Deletes are written as a special marker called a **tombstone**.
2. **All keys must fit in RAM**, and there are **no range queries**. "All users with id between 1000 and 2000" means checking every key, because a hash map has no order.

## Step 3: LSM trees and SSTables

What if each segment file were **sorted by key**? That's an **SSTable** (Sorted String Table). Sorted files give you three superpowers:

- **Merging is cheap**, like the merge step of merge sort: read several files side by side, write one sorted output.
- **Sparse index:** you don't need every key in memory. Remember one key every few KB; to find `"hello"`, jump to the nearest indexed key before it and scan a few KB.
- **Range queries** work: the data is in order.

But how do you write a *sorted* file when writes arrive in random order? You sort in memory first. That's the **LSM tree** (Log-Structured Merge tree):

```text
 write("k", v)
     |
     +--> 1. append to write-ahead log on disk (for crash recovery)
     +--> 2. insert into MEMTABLE (sorted structure in RAM, e.g. a skip list)

 memtable reaches ~64 MB
     |
     +--> flush to disk as a new immutable SSTable

 Disk:   [SSTable 5 (newest)] [SSTable 4] [SSTable 3] ... [SSTable 1 (oldest)]
 Background: compaction merges SSTables, drops overwritten values and tombstones
```

**Reading key k:** check the memtable, then the newest SSTable, then the next, and so on until found. Searching many files is slow for keys that *don't exist*, so each SSTable has a **Bloom filter** (Day 25): a tiny structure that answers "definitely not here" or "maybe here", letting you skip most files without touching disk.

Who uses LSM trees: **RocksDB**, **LevelDB**, **Cassandra**, **ScyllaDB**, **HBase**, Google **Bigtable**. They shine for write-heavy workloads: logs, metrics, messages, event streams.

## Step 4: B-trees

The B-tree (1970) is the other giant, and the default in relational databases: **PostgreSQL**, **MySQL InnoDB**, **SQLite**, **SQL Server**, **Oracle**.

Instead of growing files, a B-tree splits the data into fixed-size **pages** (blocks): 8 KB in PostgreSQL, 16 KB in InnoDB, 4 KB in many textbooks. Pages form a tree. Each internal page holds sorted keys and pointers to child pages, each covering a range:

```text
                    [ 100 | 200 ]                    root page
                   /      |      \
        [ 20 | 50 ]  [ 120 | 160 ]  [ 250 | 300 ]    internal pages
         /  |  \       ...              ...
     [1..19][20..49][50..99]                          leaf pages hold the rows
                                                      (or pointers to them)
```

**Reading key 135:** root says "between 100 and 200, go middle", next page says "between 120 and 160", then you land in a leaf. One page read per level.

**Writing:** find the leaf and **overwrite the page in place**. If it's full, **split** it into two half-full pages and add a key to the parent (which can split too, all the way up; that's how the tree grows taller). Splits keep the tree **balanced**: every leaf is at the same depth.

Because a page overwrite isn't atomic (a crash halfway through a split would corrupt the tree), B-trees also write every change to a **write-ahead log (WAL)** first.

## The math: why B-trees are so shallow

The number of child pointers per page is the **branching factor**. With 8 KB pages and small keys it's typically several hundred. Say 500.

```text
levels  pages reachable          rows (if a leaf holds ~100 rows)
1       1                        100
2       500                      50,000
3       500^2 = 250,000          25 million
4       500^3 = 125,000,000      12.5 billion
```

So **4 levels** cover billions of rows. Compare a binary tree: `log2(12,500,000,000) ≈ 33.5` levels. Since the top two levels are tiny (a few MB) and stay cached in RAM, a lookup typically costs **1–2 real disk reads**. At ~100 µs per SSD read that's well under a millisecond.

The famous estimate from *Designing Data-Intensive Applications*: a four-level tree of 4 KB pages with branching factor 500 can address up to `500^4 × 4 KB = 256 TB`.

## Amplification: the three costs

Interviewers love these words. They measure how much *extra* work the engine does compared to the data you asked for.

- **Write amplification:** bytes actually written to disk ÷ bytes the app wrote.
  - B-tree: change one 100-byte row → write it to the WAL *and* rewrite a whole 8 KB page. `8,192 / 100 ≈ 80×` in the worst case for that page (databases batch many changes per page, so the average is lower).
  - LSM: each value is written to the WAL, then the memtable flush, then rewritten again by *each* level of compaction. Typical totals are roughly 10–30×.
- **Read amplification:** disk reads per lookup. B-tree: ~tree depth, very predictable. LSM: possibly one check per SSTable level; Bloom filters and caching keep it low, but it's higher and more variable.
- **Space amplification:** disk used ÷ live data. LSM keeps stale versions until compaction; B-trees leave pages partly empty after splits (often ~30% free space).

Why write amplification matters: SSDs wear out after a limited number of writes, and disk bandwidth spent rewriting is bandwidth not serving users.

## B-tree vs LSM tree

| | B-tree | LSM tree |
|---|---|---|
| Write pattern | random in-place page updates | sequential appends + background merges |
| Write throughput | good | excellent |
| Read latency | fast and predictable | good, can vary (compaction, many files) |
| Range queries | excellent | good (merge across files) |
| Space | some empty space in pages | stale data until compacted, compresses well |
| Background work | little | compaction can cause latency spikes |
| Typical users | PostgreSQL, MySQL, SQLite | RocksDB, Cassandra, LevelDB, HBase |

The honest answer is **"it depends on the workload, so measure"**. A rough rule: read-heavy with lots of range queries and transactions → B-tree. Very high write rates (metrics, logs, events) → LSM.

## In an interview

You rarely implement these, but they appear when you justify a database choice: "Cassandra is LSM-based, so it handles our 500k writes/sec of location pings well", or in a deep dive like "how would you build a key-value store?" (Day 66).

> "B-trees keep data in fixed-size sorted pages, update them in place, and stay 3–4 levels deep even for billions of rows, so reads are fast and predictable; that's why relational databases use them. LSM trees buffer writes in a sorted memtable, flush immutable SSTables sequentially and merge them in the background, so writes are very cheap but reads may check several files, which Bloom filters mitigate. The trade-off is captured by write, read and space amplification."

## Common mistakes

- **"Append-only means data can't be updated."** Updates are new appends; the newest value wins, and compaction removes old ones.
- **"LSM trees are always faster."** Faster *writes*, usually. Reads and range scans can be slower, and compaction competes for disk.
- **Forgetting crash safety.** The memtable lives in RAM; without the WAL, a crash loses it.
- **Thinking a B-tree is a binary tree.** It has hundreds of children per node; that's the whole point.
- **Saying "index" only means B-tree.** Hash indexes, LSM, inverted indexes (Day 37) are all indexes.

## Before moving on

- [ ] I can write a 10-line append-only log store and explain why reads are `O(n)`
- [ ] I can explain how a hash index, segments and compaction fix it
- [ ] I can describe memtable → SSTable → compaction and where Bloom filters help
- [ ] I can compute how many rows a 4-level B-tree can hold
- [ ] I can define write, read and space amplification with an example

## Go deeper (optional)

- *Designing Data-Intensive Applications* by Martin Kleppmann, chapter 3 "Storage and Retrieval"
- [Wikipedia: B-tree](https://en.wikipedia.org/wiki/B-tree)
- [Wikipedia: Log-structured merge-tree](https://en.wikipedia.org/wiki/Log-structured_merge-tree)
- [RocksDB wiki](https://github.com/facebook/rocksdb/wiki)
