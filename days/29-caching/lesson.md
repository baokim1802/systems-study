# Caching

> A cache keeps a copy of hot data somewhere faster and closer. It's the single most effective trick for making systems fast and cheap, and also a famous source of bugs.

## The big idea

You keep a few things on your desk: your phone, a pen, today's notes. Everything else lives in a cupboard down the hall. The desk is small but instant; the cupboard is big but slow. You don't plan any of this carefully: whatever you used recently stays on the desk, and when the desk is full, the thing you haven't touched in longest goes back to the cupboard.

That's a **cache**: a small, fast storage layer holding copies of data whose real home (the **source of truth**) is bigger and slower. Day 5 showed caches inside your CPU. The same idea repeats at every level of a system:

```text
browser cache → CDN (Day 30) → in-process memory → Redis/Memcached → database's own buffer cache → disk
   fastest, closest, smallest  ─────────────────────────────────────►  slowest, farthest, biggest
```

Two words you'll use constantly:

- **Cache hit**: the data was in the cache. Fast.
- **Cache miss**: it wasn't. You go to the source of truth (slow), and usually store a copy for next time.

**Hit rate** = hits / (hits + misses). A cache is only as good as its hit rate.

## Why caching works so well: the math

Suppose a Redis lookup takes **1 ms** and a database query takes **20 ms**. On a miss you pay both (check the cache, then the DB).

```text
average latency = hit_rate × 1 ms + (1 − hit_rate) × (1 ms + 20 ms)

hit rate 0%   → 21 ms      (worse than no cache at all!)
hit rate 50%  → 0.5 + 10.5 = 11 ms
hit rate 90%  → 0.9 + 2.1  = 3 ms
hit rate 99%  → 0.99 + 0.21 = 1.2 ms
```

And the database load:

```text
10,000 reads/s with a 90% hit rate → only 1,000 reach the DB
                 with a 99% hit rate → only   100 reach the DB
```

Going from 90% to 99% looks like a small step, but it cuts database traffic by **10×**. Small changes in hit rate have huge effects on the backend.

Why do hit rates get that high? Because real access is **skewed**: a small fraction of items gets most of the traffic (the famous post, the homepage, the popular product). This is often summarized as the **80/20 rule**: roughly 20% of items get 80% of the requests. Cache that 20% and you serve most traffic from memory.

## Caching patterns

### Cache-aside (lazy loading): the default

The **application** manages the cache. On a read: check the cache; on a miss, read the DB and fill the cache.

```js
async function getUser(id) {
  const key = `user:${id}`;
  const cached = await redis.get(key);
  if (cached) return JSON.parse(cached);                 // hit

  const user = await db.query('SELECT * FROM users WHERE id = $1', [id]); // miss
  await redis.set(key, JSON.stringify(user), { EX: 300 }); // keep for 5 minutes
  return user;
}

async function updateUser(id, fields) {
  await db.query('UPDATE users SET ... WHERE id = $1', [id]);
  await redis.del(`user:${id}`); // invalidate: next read will reload fresh data
}
```

- Pros: only data that's actually requested gets cached; if the cache dies, the app still works (just slower).
- Cons: the first request for each item is slow; there's a window where the cache can hold stale data.

Note the update **deletes** the key instead of writing the new value into it. Deleting is safer: if two updates race, a "set" could leave the older value in the cache, while a "delete" just forces a fresh reload.

### Read-through

Like cache-aside, but the **cache library** loads from the DB on a miss, so the app only talks to the cache. Same behavior, cleaner code.

### Write-through

Every write goes to the cache **and** the database, synchronously, before returning success.

- Pros: cache always has fresh data for things that were written.
- Cons: every write is slower (two writes); you cache data that may never be read.

### Write-back (write-behind)

Writes go to the cache only, and the cache flushes them to the database later, in batches.

- Pros: very fast writes; batching reduces database load (great for counters like view counts).
- Cons: **if the cache crashes before flushing, those writes are lost.** Only use it where that's acceptable or the cache is durable.

### Write-around

Writes go straight to the database, skipping the cache; the cache is filled only on reads. Good when written data is rarely re-read soon (e.g. logs).

| Pattern | Read path | Write path | Main risk |
|---|---|---|---|
| Cache-aside | App checks cache, loads DB on miss | App writes DB, deletes cache key | Stale reads in a small window |
| Write-through | From cache | Cache + DB together | Slower writes |
| Write-back | From cache | Cache now, DB later | Data loss on cache crash |
| Write-around | Cache-aside style | DB only | First read after write is a miss |

## Expiry and invalidation

> "There are only two hard things in Computer Science: cache invalidation and naming things." (Phil Karlton)

The cache holds copies, and copies go **stale** when the original changes. Your tools:

- **TTL (time to live)**: every entry expires after N seconds. Simple and a great safety net: even if you forget to invalidate somewhere, staleness is bounded by the TTL. Choose it by asking "how stale can this be?": seconds for stock levels, hours for a user's avatar URL.
- **Explicit invalidation**: delete the key when the data changes (as in `updateUser` above).
- **Versioned keys**: include a version in the key (`user:42:v7`). Changing data bumps the version, so old entries are simply never read again.

Use TTL *and* invalidation together: invalidation for freshness, TTL as a backstop.

## Eviction: when the cache is full

Memory is limited, so the cache must choose what to throw out. The **eviction policy**:

- **LRU (least recently used)**: evict the item not touched for the longest time. The default almost everywhere.
- **LFU (least frequently used)**: evict the item used the fewest times. Better when popularity is stable.
- **FIFO**: evict the oldest inserted, regardless of use. Simple, usually worse.

### Implement an LRU cache

A classic interview question: `get` and `put` in `O(1)`. In JavaScript, a `Map` remembers insertion order, which makes this short: to mark a key as recently used, delete it and re-insert it at the end. The **first** key in the Map is then the least recently used.

```js
class LRUCache {
  constructor(capacity) {
    this.capacity = capacity;
    this.map = new Map(); // oldest first, newest last
  }

  get(key) {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key);
    this.map.delete(key);       // move to the end = most recently used
    this.map.set(key, value);
    return value;
  }

  put(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value; // first key = least recently used
      this.map.delete(oldest);
    }
  }
}

const c = new LRUCache(2);
c.put('a', 1); c.put('b', 2);
c.get('a');          // touch a; now b is least recent
c.put('c', 3);       // evicts b
console.log([...c.map.keys()]); // [ 'a', 'c' ]
```

In other languages (or if an interviewer forbids the `Map` trick) you build the same thing from a **hash map + doubly linked list**: the hash map finds a node in `O(1)`, and the linked list moves it to the front or removes the tail in `O(1)`.

## The thundering herd (cache stampede)

A very popular key (say, the homepage) expires. In the next 50 ms, 5,000 requests all miss at once, and **all 5,000** hit the database to rebuild the same value. The database falls over, which makes everything slower, which causes more misses. This is the **thundering herd** or **cache stampede**.

Fixes:

1. **Request coalescing (single flight)**: only one request rebuilds the value; the others wait for its result.
2. **A lock**: the first miss takes a short lock in Redis (`SET key:lock 1 NX EX 10`); others serve stale data or wait briefly.
3. **Refresh early**: rebuild the value in the background *before* it expires (or randomly early, as it gets close).
4. **TTL jitter**: add randomness (`300 ± 30 s`) so many keys cached at the same moment don't all expire at the same moment.

Single flight in a few lines of JavaScript:

```js
const inFlight = new Map(); // key -> Promise

function singleFlight(key, loader) {
  if (inFlight.has(key)) return inFlight.get(key);     // join the existing load
  const p = loader().finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}
// 5,000 concurrent calls to singleFlight('home', buildHome) → buildHome runs once (per process)
```

## Other caching problems to know

- **Cache penetration**: requests for keys that don't exist (e.g. `user:-1`) always miss and always hit the DB. Fix: cache the "not found" result briefly, or check a Bloom filter first (Day 25).
- **Hot keys**: one key gets so much traffic that one Redis node melts. Fix: replicate that key, or keep a tiny in-process cache in front for a second or two.
- **Cold start**: after a restart the cache is empty and the DB gets everything at once. Fix: warm the cache before taking traffic.
- **Inconsistency**: a cache is a second copy, so it can disagree with the database. Decide how much staleness each piece of data can tolerate.

## In an interview

Caches appear in almost every design. Interviewers want to hear:

- **What** you cache (and why it's read-heavy and skewed enough to benefit) and **where** (CDN, Redis, in-process).
- **The pattern** (usually cache-aside) and **how it stays fresh** (invalidate on write + TTL).
- **Numbers**: expected hit rate and what it does to DB load.
- **Failure modes**: stampede, hot keys, cache down.

Sample answer: *"Product pages are read 100× more than they change, and traffic is very skewed, so I'd use cache-aside with Redis, a 10-minute TTL with jitter, and delete the key whenever a product is updated. At a 95% hit rate, 20k reads/s becomes 1k on the database. To avoid a stampede on popular products, rebuilds go through a single-flight lock, and if Redis is down we fall back to the DB with a rate limit."*

## Common mistakes

- **Caching without a plan for invalidation.** Decide upfront how stale data can get.
- **Updating the cache on write instead of deleting.** Races can leave old values cached.
- **No TTL.** A missed invalidation then means stale data forever.
- **Treating the cache as the database.** Caches evict and crash; the source of truth must be elsewhere (unless you've deliberately chosen write-back).
- **Caching things with low hit rates.** A cache with a 10% hit rate mostly adds latency.

## Before moving on

- [ ] I can compute average latency and DB load from a hit rate
- [ ] I can explain cache-aside, write-through and write-back and pick one
- [ ] I can implement an LRU cache with `O(1)` get and put
- [ ] I can explain a cache stampede and two ways to prevent it
- [ ] I know why we delete the cache key on update instead of overwriting it

## Go deeper (optional)

- [Cache (computing) on Wikipedia](https://en.wikipedia.org/wiki/Cache_(computing))
- [Cache replacement policies on Wikipedia](https://en.wikipedia.org/wiki/Cache_replacement_policies)
- [Redis documentation](https://redis.io/docs/) (search for "key eviction")
- Facebook's paper "Scaling Memcache at Facebook" (NSDI 2013), which describes leases for stampedes and stale sets
