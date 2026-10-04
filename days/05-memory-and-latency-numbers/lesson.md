# Memory and Latency Numbers

> The single most useful fact in system design is that different places to keep data differ in speed by factors of a million. Once you have a feel for "nanoseconds vs microseconds vs milliseconds", you can tell in seconds whether a design will be fast, and why caches exist everywhere.

## The big idea

You are cooking. Where is the salt?

- **In your hand**: instant.
- **On the counter**: a second.
- **In the cupboard**: a few seconds.
- **In the basement storeroom**: a minute or two.
- **At the store across town**: an hour.
- **Shipped from another country**: weeks.

A good cook keeps what they use most in hand or on the counter, and goes to the store rarely and buys a lot at once. Computers are built the same way. This is the **memory hierarchy**: small, fast, expensive storage close to the CPU; big, slow, cheap storage far away.

```text
          fastest, smallest, priciest per byte
             ┌──────────┐
             │ registers│  < 1 KB          ~0.3 ns
            ┌┴──────────┴┐
            │  L1 cache  │  32–64 KB/core   ~1 ns
           ┌┴────────────┴┐
           │   L2 cache   │  1–2 MB/core     ~4 ns
          ┌┴──────────────┴┐
          │    L3 cache    │  tens of MB      ~10–20 ns
         ┌┴────────────────┴┐
         │    RAM (DRAM)    │  16 GB – 1 TB+   ~100 ns
        ┌┴──────────────────┴┐
        │   SSD (NVMe)       │  TBs             ~20–100 µs
       ┌┴────────────────────┴┐
       │   HDD (spinning)     │  many TBs        ~5–10 ms
      ┌┴──────────────────────┴┐
      │  network: other DC     │  unlimited       ~10–150 ms
      └────────────────────────┘
          slowest, biggest, cheapest per byte
```

Units, since they are about to matter a lot:

```text
1 second      = 1,000 milliseconds (ms)
1 millisecond = 1,000 microseconds (µs)
1 microsecond = 1,000 nanoseconds  (ns)
```

## Latency numbers every programmer should know

This list was made famous by Jeff Dean and Peter Norvig. Exact values change with hardware generations; the **orders of magnitude** are what you memorize.

| Operation | Approx. time | Notes |
|---|---|---|
| L1 cache reference | 1 ns | |
| L2 cache reference | 4 ns | |
| Branch mispredict | 5 ns | Day 04 |
| Mutex lock/unlock (uncontended) | 20 ns | Day 07 |
| Main memory (RAM) reference | 100 ns | 100× L1 |
| Compress 1 KB (fast compressor) | 2 µs | |
| Send 1 KB over a 10 Gbps network | 1 µs | just the bits on the wire |
| Read 4 KB randomly from an NVMe SSD | 20–100 µs | |
| Read 1 MB sequentially from RAM | 10–50 µs | |
| Round trip within a datacenter | 500 µs | 0.5 ms |
| Read 1 MB sequentially from SSD | 200 µs – 1 ms | |
| HDD seek | 5–10 ms | moving a physical arm |
| Read 1 MB sequentially from HDD | 5–10 ms | ~100–200 MB/s |
| Round trip US East ↔ US West | ~70 ms | |
| Round trip California ↔ Europe | ~150 ms | |

### Make it human

Our brains cannot feel the difference between 1 ns and 100 µs. Scale everything up so that **one L1 cache hit (1 ns) takes one second**:

```text
L1 cache hit               1 s
L2 cache hit               4 s
RAM access               100 s    (~2 minutes)
SSD random read      100,000 s    (~1 day)
Datacenter round trip 500,000 s   (~6 days)
HDD seek          10,000,000 s    (~4 months)
California→Europe 150,000,000 s   (~5 years)
```

If a CPU could think, every trip to RAM would feel like waiting two minutes, and every cross-ocean request like waiting five years. This is why "avoid the network round trip" and "keep it in memory" dominate system design.

## Latency vs bandwidth

Two different questions:

- **Latency**: how long until the *first* byte arrives? (How long is the road?)
- **Bandwidth / throughput**: how many bytes per second once it flows? (How many lanes?)

A truck full of hard drives driving across the country has terrible latency (days) and enormous bandwidth (petabytes). AWS literally offered this as a service ("Snowmobile").

| Medium | Rough bandwidth |
|---|---|
| RAM | 20–100 GB/s |
| NVMe SSD | 3–7 GB/s |
| SATA SSD | ~550 MB/s |
| HDD (sequential) | 100–250 MB/s |
| 10 Gbps network | 1.25 GB/s |
| 1 Gbps network | 125 MB/s |

Note the classic unit trap: networks are quoted in **bits** per second, storage in **bytes**. Divide by 8.

## Caches and locality

Why do caches work at all, if they are so small? Because programs are predictable in two ways:

- **Temporal locality**: if you used something, you will probably use it again soon (a loop counter, a popular user's profile).
- **Spatial locality**: if you used something, you will probably use its neighbors soon (the next element of an array).

The CPU exploits spatial locality by never fetching a single byte from RAM. It fetches a whole **cache line**, 64 bytes on almost all modern chips. Reading `arr[0]` of a `Float64Array` pulls in `arr[0]` through `arr[7]` for free. Hardware **prefetchers** also notice "you are walking forward through memory" and fetch the next lines before you ask.

The result: walking memory **in order** is dramatically faster than jumping around, even though both are "O(n)".

```js
// A 2048 x 2048 grid of doubles stored row by row in one flat array (32 MB).
const N = 2048, grid = new Float64Array(N * N).fill(1);

function sumRows() {               // walks memory in order: cache-friendly
  let s = 0;
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) s += grid[r * N + c];
  return s;
}
function sumCols() {               // jumps 16 KB each step: a cache miss almost every read
  let s = 0;
  for (let c = 0; c < N; c++) for (let r = 0; r < N; r++) s += grid[r * N + c];
  return s;
}
console.time("rows"); sumRows(); console.timeEnd("rows");
console.time("cols"); sumCols(); console.timeEnd("cols");   // typically several times slower
```

Same number of additions, same Big-O, very different speed. It is also why arrays usually beat linked lists in practice: list nodes are scattered around the heap, so each `node.next` can be a 100 ns trip to RAM.

## The same idea, all the way up

The hierarchy does not stop at the chip. System design is largely the art of putting a fast layer in front of a slow one:

| Slow thing | Fast layer in front | Day |
|---|---|---|
| RAM | CPU caches | today |
| Disk | OS page cache (RAM) | 08 |
| Database | Redis / Memcached | 29 |
| Origin server far away | CDN edge near the user | 30 |
| Repeating a computation | memoization | — |

Every one of these works for the same reason (locality) and has the same problems: it is smaller than what it caches, and it can be **stale**.

## The math

**Average memory access time.** A cache hits 95% of the time at 1 ns; a miss goes to RAM at 100 ns:

```text
average = hit rate × hit time + miss rate × miss time
        = 0.95 × 1 + 0.05 × 100 = 0.95 + 5 = 5.95 ns
at 99% hits: 0.99 + 1 = 1.99 ns   ← 4 points of hit rate = 3× faster
```

The misses dominate. The same math applies to a Redis cache in front of a database (Day 29).

**Sequential round trips add up.** A page makes 30 database queries one after another, each a 0.5 ms datacenter round trip plus 1 ms of query time:

```text
30 × 1.5 ms = 45 ms   just waiting
batched into 1 query: ~1.5–3 ms
```

That is the famous **N+1 query problem**: fetch a list, then one extra query per item.

**Reading 1 GB:**

```text
from RAM       at 50 GB/s   ≈ 20 ms
from NVMe SSD  at 3 GB/s    ≈ 0.33 s
from HDD       at 150 MB/s  ≈ 6.7 s
over 1 Gbps    at 125 MB/s  ≈ 8 s
```

**Speed of light.** Light in optical fiber travels about 200,000 km/s, so **1 ms per 200 km one way**, or 1 ms of round trip per 100 km. New York to London is about 5,600 km:

```text
one way ≥ 5,600 / 200,000 s = 28 ms   → round trip ≥ 56 ms (real: ~70–80 ms)
```

No amount of engineering beats physics; only moving data closer to users (CDNs, regional replicas) does.

## In an interview

These numbers are the units you reason in. Interviewers listen for:

- "That's a network hop, about half a millisecond in the same datacenter; doing it 100 times per request is 50 ms."
- "A cross-region synchronous write adds roughly 50–150 ms, so we'd replicate asynchronously."
- "The hot set fits in RAM (say 20 GB), so we can cache all of it."
- "Random reads on HDD are ~100 per second; on SSD tens of thousands."

A good short answer to "why cache?": *"Memory is about 100 ns, an SSD read about 100 µs, a datacenter round trip about 0.5 ms and a cross-continent one 100+ ms. Caching puts frequently used data in a faster layer, exploiting temporal and spatial locality; with a high hit rate the average access time approaches the fast layer's, at the cost of memory and staleness."*

## Common mistakes

- **Mixing up ms, µs, ns.** Write the unit every time. 1 ms = 1,000,000 ns.
- **Mixing bits and bytes.** 1 Gbps ≈ 125 MB/s.
- **Thinking Big-O is the whole story.** Access patterns (locality) can change speed by 10× at the same Big-O.
- **Ignoring round trips.** Many small sequential calls are slower than one big call, even if the total data is the same.
- **Memorizing exact digits.** Memorize orders of magnitude; say "roughly" in interviews.

## Before moving on

- [ ] I can draw the memory hierarchy with rough sizes and latencies
- [ ] I know L1 ≈ 1 ns, RAM ≈ 100 ns, SSD ≈ 100 µs, DC round trip ≈ 0.5 ms, HDD seek ≈ 10 ms, cross-continent ≈ 100+ ms
- [ ] I can explain temporal and spatial locality and what a cache line is
- [ ] I can compute an average access time from a hit rate
- [ ] I can explain the difference between latency and bandwidth

## Go deeper (optional)

- [Memory hierarchy — Wikipedia](https://en.wikipedia.org/wiki/Memory_hierarchy)
- [Locality of reference — Wikipedia](https://en.wikipedia.org/wiki/Locality_of_reference)
- Peter Norvig, "Teach Yourself Programming in Ten Years" (the original latency table)
- Ulrich Drepper, "What Every Programmer Should Know About Memory" (2007)
- *Designing Data-Intensive Applications* by Martin Kleppmann
