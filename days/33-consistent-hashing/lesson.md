# Consistent Hashing

> When you spread data or traffic across servers with a hash, adding or removing one server shouldn't reshuffle everything. Consistent hashing is the clever trick that makes "just add a machine" cheap.

## The big idea

Imagine 4 friends sharing the job of answering letters. You assign each letter by a rule: "take the sender's ID number, divide by 4, and the remainder says who answers it". Works fine. Then a 5th friend joins and you change the rule to "divide by 5". Suddenly almost every sender has a *different* friend than before, so everyone has to hand over their files. Chaos, for the sake of one new helper.

Now a better rule. Draw a big clock face. Each friend picks a spot on the clock. Each letter is also placed on the clock (by its sender ID), and it goes to the **first friend clockwise** from it. When a 5th friend joins, they take a spot on the clock and only grab the letters between their spot and the previous friend's spot. Everyone else's letters stay exactly where they were.

That clock is the **hash ring**, and the rule is **consistent hashing**. It was introduced in a 1997 paper by Karger and others at MIT for web caching, and the idea behind it now sits inside Amazon's Dynamo, Cassandra, Riak, many CDNs and load balancers (Day 28), and memcached client libraries.

## Why `hash % n` breaks

Day 32 showed this, so let's make it concrete. With `n` servers the classic mapping is:

```text
server = hash(key) % n
```

Change `n` from 4 to 5 and a key stays put only if `hash % 4 === hash % 5`. Over every 20 consecutive hash values that's true for only 4 of them (0, 1, 2, 3), so **80% of keys move**. In general, going from `n` to `n + 1` servers, only about `1/(n+1)` of keys stay and about `n/(n+1)` move.

```text
n → n+1      keys that move with % n      keys that SHOULD move (ideal)
4 → 5        ~80%                          ~20%  (the new server's fair share)
10 → 11      ~91%                          ~9%
100 → 101    ~99%                          ~1%
```

Why does this hurt? If the servers are **caches**, almost every key now points at a server that doesn't have it, so the hit rate collapses to near zero and the database gets hammered (a stampede, Day 29). If they're **database shards**, almost all the data has to be copied across the network at once.

The ideal: when a server is added, only the keys that the new server should own move, about `1/(n+1)` of them, and they move only *to* the new server. When a server is removed, only *its* keys move, spread over the survivors. Consistent hashing gets very close to that.

## How the ring works

1. Pick a hash function with a big output range, say 32 bits: `0` to `2^32 − 1` (about 4.3 billion). Imagine bending that number line into a circle, so `2^32 − 1` is next to `0`.
2. **Place each server on the ring** by hashing its name: `hash("server-A")` gives its position.
3. **Place each key on the ring** with the same hash function: `hash("user:42")`.
4. **A key belongs to the first server found going clockwise** from the key's position (wrapping past the top back to 0).

```text
The ring, drawn as a line whose right end joins back to its left end:

0 ───k1───A─────k2─────B────────C────k3───D───k4───► 2^32 (= back to 0)

k1 → A   (first server to its right / clockwise)
k2 → B
k3 → D
k4 → A   (runs off the end, wraps around to the first server)
```

### Adding a server

Add server E between C and D. E takes over only the keys between C and E (keys that used to go to D, since D was the next server clockwise). Every other key's "next server clockwise" is unchanged.

### Removing a server

If B dies, keys that went to B now continue clockwise to the next server, C. Nothing else moves.

So adding or removing one server moves about `1/n` of the keys, and only to or from that server's neighbor. That's the whole trick.

## The problem: uneven arcs

With only a few servers placed by a random hash, the gaps between them are very uneven. One server might own 50% of the ring and another 5%. Here's what a real run with 4 servers and **one point each** gave for 100,000 keys:

```text
C: 54,594   A: 24,932   B: 15,272   D: 5,202     ← C has 10× the load of D!
```

And when a server dies, its whole arc goes to just **one** neighbor, which might double that neighbor's load.

## Virtual nodes

The fix: put each physical server on the ring **many times**, under different names (`A#0`, `A#1`, … `A#199`). Each of these points is a **virtual node** (vnode). Now every server owns many small arcs scattered around the ring instead of one big arc, and the random sizes average out.

```text
one point per server:      [AAAAAAAAAAAAAAAAAAAA|BBBBB|CCCCCCCCCC|D]
many points per server:    [A|C|B|D|A|B|D|C|A|D|B|C|A|C|D|B|A|D|C|B]
```

Benefits:

- **Even load.** In simulations with 10 servers and 100,000 keys, the busiest server averaged **2.6×** its fair share with 1 point per server, **1.6×** with 10 vnodes, **1.16×** with 100, and **1.05×** with 1,000.
- **Even failover.** When a server dies, its many small arcs are inherited by *many different* neighbors, so the extra load is spread across the whole cluster instead of landing on one server.
- **Weighted servers.** A machine with twice the capacity gets twice as many vnodes.

The cost is memory and lookup time for a bigger ring: 100 servers × 200 vnodes = 20,000 points, which is tiny, and lookups are a binary search (`log2(20,000) ≈ 15` steps).

## Build a small ring in JavaScript

We keep the ring as an array of points sorted by position. To find a key's server, hash the key and **binary search** for the first point at or after it (the same "first true" pattern as binary search on sorted arrays), wrapping to index 0 if we run off the end.

```js
// 32-bit FNV-1a plus a final mixing step, so similar strings land far apart
function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

class HashRing {
  constructor(vnodes = 200) {
    this.vnodes = vnodes;
    this.ring = []; // sorted array of { pos, node }
  }
  addNode(node) {
    for (let i = 0; i < this.vnodes; i++) {
      this.ring.push({ pos: hash(`${node}#${i}`), node });
    }
    this.ring.sort((a, b) => a.pos - b.pos);
  }
  removeNode(node) {
    this.ring = this.ring.filter((p) => p.node !== node);
  }
  getNode(key) {
    if (this.ring.length === 0) return undefined;
    const h = hash(key);
    let lo = 0, hi = this.ring.length;       // find the first point with pos >= h
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.ring[mid].pos < h) lo = mid + 1;
      else hi = mid;
    }
    return this.ring[lo % this.ring.length].node; // lo === length → wrap to 0
  }
}
```

Now let's measure how many keys move when we add a fifth server:

```js
const ring = new HashRing(200);
['A', 'B', 'C', 'D'].forEach((n) => ring.addNode(n));

const keys = Array.from({ length: 100000 }, (_, i) => `user:${i}`);
const before = new Map(keys.map((k) => [k, ring.getNode(k)]));

const counts = {};
for (const n of before.values()) counts[n] = (counts[n] || 0) + 1;
console.log(counts); // { D: 26376, B: 25214, A: 24956, C: 23454 }  ← close to 25,000 each

ring.addNode('E');
const moved = keys.filter((k) => ring.getNode(k) !== before.get(k));
console.log(`${(100 * moved.length / keys.length).toFixed(1)}% moved`); // 21.5% moved
console.log(moved.every((k) => ring.getNode(k) === 'E'));              // true
```

Compare with `hash(key) % 4` → `% 5`, which moves about **80%** of the same keys. And the last line proves the key property: **every key that moved, moved to the new server E**. No keys shuffled between the old servers.

(The 21.5% isn't exactly the ideal 20% because vnode placement is random; more vnodes get it closer.)

## The math: keys moved

With `K` keys spread evenly over `n` servers:

```text
add one server:    about K / (n + 1) keys move (all of them to the new server)
remove one server: about K / n keys move (that server's keys, spread to the others)

Example: 10 million cached keys, 9 servers → add a 10th
  consistent hashing:  10,000,000 / 10 = 1,000,000 keys move   (10%)
  hash % n:            about 9/10 of keys move ≈ 9,000,000      (90%)
```

For a cache in front of a database at 50,000 reads/s, that's the difference between a short dip (10% of reads miss for a while) and an instant 90% miss rate that could flatten the database.

## Where you'll see it

- **Distributed caches**: memcached client libraries (e.g. the "ketama" algorithm) pick a cache server per key with a ring.
- **Distributed databases**: Dynamo-style stores (Cassandra, Riak) place data on a ring. To replicate, a key is stored on the first `N` **distinct** servers clockwise, a neat combination with Day 31's leaderless replication.
- **Load balancers**: hashing a user or URL to a backend for cache affinity (Day 28), so adding a backend doesn't move every user. Nginx has a `hash ... consistent` option, and Envoy offers "ring hash" and "Maglev" load balancing.
- **CDNs**: choosing which server inside a PoP caches a given URL (Day 30).

Related alternatives worth knowing by name: **rendezvous hashing** (highest random weight: for each key, score every server with `hash(key + server)` and pick the highest; no ring needed), and **jump consistent hash** (Google, 2014: tiny and fast, but servers can only be added or removed at the end of a numbered list). And remember the simplest alternative from Day 32: a **fixed number of partitions** with a lookup table.

## In an interview

Consistent hashing comes up whenever you shard a cache or a key-value store. A strong answer:

- Explains **why `% n` fails** (almost every key moves on resize) with a number.
- Describes the **ring**: hash servers and keys into the same space, key goes to the next server clockwise.
- Brings up **virtual nodes** without being asked: they fix uneven load and spread a failed server's load across many survivors.
- States **how many keys move**: about `1/(n+1)` on add.
- Mentions **replication** on the ring: store on the next `N` distinct servers.

Sample answer: *"With `hash % n`, adding a cache node remaps about `n/(n+1)` of keys, which would wipe out our hit rate. Instead I'd use consistent hashing: servers and keys are hashed onto a ring, and each key goes to the next server clockwise, so adding a node moves only about `1/(n+1)` of keys, all to the new node. Each server gets ~100–200 virtual nodes so load is even, and if a node dies its keys spread across many others rather than doubling one neighbor's load."*

## Common mistakes

- **Forgetting virtual nodes.** A ring with one point per server is badly unbalanced.
- **Thinking consistent hashing fixes hot keys.** One very popular key still lives on one server. You still need caching or key splitting (Day 32).
- **Wrapping bugs.** A key hashed past the last point must go to the **first** point in the ring.
- **Using a weak hash.** Poorly mixed hashes cluster vnodes together. Use a well-mixed hash (MurmurHash, xxHash, or a good mixing step as above).
- **Replicating to the next N points instead of the next N distinct servers.** With vnodes, the next few points may belong to the same machine.

## Before moving on

- [ ] I can explain with numbers why `hash % n` breaks when `n` changes
- [ ] I can describe the ring and find a key's server by walking clockwise
- [ ] I can explain what virtual nodes fix (two things)
- [ ] I can implement a ring with binary search lookup in JavaScript
- [ ] I can say how many keys move when one server is added or removed

## Go deeper (optional)

- [Consistent hashing on Wikipedia](https://en.wikipedia.org/wiki/Consistent_hashing)
- [Rendezvous hashing on Wikipedia](https://en.wikipedia.org/wiki/Rendezvous_hashing)
- Karger et al., "Consistent Hashing and Random Trees" (STOC 1997)
- DeCandia et al., "Dynamo: Amazon's Highly Available Key-value Store" (2007), section 4.2
- Lamping and Veach, "A Fast, Minimal Memory, Consistent Hash Algorithm" (2014), the jump hash paper
