# Hashing, Checksums and Bloom Filters

> Hashing is everywhere in systems: hash maps, sharding, caching, passwords, Git, downloads, deduplication. Today you learn what a hash function really is, why collisions arrive much sooner than you'd guess (the birthday paradox), how checksums catch corrupted data, and how a Bloom filter answers "have I seen this before?" for a billion items using a few hundred megabytes.

## The big idea

A **hash function** takes any input (a word, a file, a whole movie) and turns it into a **fixed-size number** that looks random. Same input, same number, every time.

Think of it like a coat-check system that assigns hook numbers by a secret rule based on your name. Anyone named "Ana" always goes to hook 4,817. You can find Ana's coat instantly without searching. But there are more names than hooks, so sometimes two people get the same hook: a **collision**.

```text
first 32 bits of SHA-256:
"ana"              -> 0x24d4b96f
"anb"              -> 0xbd34d63f     (tiny change in, totally different out)
<4 GB movie file>  -> 8 hex digits   (any size in, same fixed size out)
```

## What makes a good hash function

1. **Deterministic:** same input, same output.
2. **Fast** to compute.
3. **Uniform:** outputs spread evenly over the range, so buckets fill evenly.
4. **Avalanche effect:** flipping one input bit flips about half of the output bits.

Here is a real, simple, widely used one, **FNV-1a** (32-bit):

```js
function fnv1a(str) {
  let h = 2166136261;                 // FNV offset basis
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);           // mix in one character
    h = Math.imul(h, 16777619);       // multiply by the FNV prime (32-bit)
  }
  return h >>> 0;                     // as an unsigned 32-bit integer
}
console.log(fnv1a('ana').toString(16), fnv1a('anb').toString(16)); // 1429ca85 1129c5cc
```

`Math.imul` does 32-bit integer multiplication and `>>> 0` makes the result unsigned (Day 2's two's complement in action).

Notice the two outputs look alike: FNV-1a is fast and spreads keys well enough for hash tables, but its avalanche is weak when only the last character changes. Libraries that need better mixing use MurmurHash3 or xxHash, and security uses SHA-256 (below).

## Where hashing shows up

| Use | How | Day |
|---|---|---|
| Hash maps (`Map`, `{}`) | `hash(key) % buckets` picks a bucket: O(1) average lookup | here |
| Sharding / load balancing | `hash(userId)` picks a server | 28, 32, 33 |
| Caching | hash of the request is the cache key | 29 |
| Deduplication | same content → same hash → store once | 36, 60 |
| Integrity | compare a file's hash to the published one | here |
| Passwords | slow, salted hashes (bcrypt, argon2) | 47 |
| Git | every object is named by its hash | 53 |
| Signing webhooks | HMAC = hash mixed with a secret key | 18 |

## Collisions and the birthday paradox

A 32-bit hash has `2^32 ≈ 4.3 billion` possible values. Collisions must exist (more possible inputs than outputs: the **pigeonhole principle**). The surprising part is how *soon* you hit one.

**The birthday paradox:** in a room of just **23** people, there's a **50.7%** chance two share a birthday, even though there are 365 days. Why? You're not asking "does someone share *my* birthday" but "does *any pair* match", and 23 people form `23 × 22 / 2 = 253` pairs.

The general approximation, for `n` items hashed into `m` possible values:

```text
P(at least one collision) ≈ 1 - e^(-n² / (2m))

50% chance when n ≈ 1.1774 × √m
```

Worked examples:

```text
Birthdays: m = 365         n50 ≈ 1.1774 × 19.1   ≈ 22.5   -> 23 people
32-bit:    m = 2^32        n50 ≈ 1.1774 × 65,536 ≈ 77,000 items
64-bit:    m = 2^64        n50 ≈ 1.1774 × 2^32   ≈ 5.1 billion items
128-bit:   m = 2^128       n50 ≈ 2.2 × 10^19 items   (UUIDv4 has 122 random bits)
```

The lesson for system design: **a random 32-bit ID is not unique** past tens of thousands of items. Use 64-bit IDs or more, or a coordinated generator (Day 56). Check it yourself:

```js
const p = (n, m) => 1 - Math.exp(-(n * n) / (2 * m));
console.log(p(23, 365).toFixed(3));          // ~0.516 (exact answer is 0.507)
console.log(p(77_000, 2 ** 32).toFixed(3));  // ~0.499
console.log(p(1_000_000, 2 ** 64));          // ~2.7e-8: safe
```

## Checksums: catching accidents

A **checksum** is a small value computed from data so you can detect if the data changed **by accident**: a flipped bit on a disk, noise on a cable, a truncated download.

- **Parity bit:** count the 1-bits; add one bit to make the count even. Catches any single flipped bit, misses two.
- **Internet checksum:** a 16-bit ones'-complement sum used in IPv4, TCP and UDP headers (Day 12). Cheap but weak.
- **CRC32** (cyclic redundancy check): treats the data as a big polynomial and keeps the remainder of dividing by a fixed one. Detects all single-bit errors and all bursts of errors up to 32 bits long. Used in Ethernet frames, ZIP, gzip and PNG.

Storage systems store a checksum per block and verify it on read, so silently corrupted data is detected and repaired from a replica (Days 31, 36).

Checksums are **not security**. CRC is designed so that an attacker can easily craft different data with the same CRC. For protection against *deliberate* tampering you need the next kind.

## Cryptographic hashes: resisting attackers

A **cryptographic hash** like **SHA-256** (256-bit output) adds strong guarantees:

- **Preimage resistance:** given a hash, you can't find an input that produces it.
- **Second-preimage resistance:** given an input, you can't find a different one with the same hash.
- **Collision resistance:** you can't find *any* two inputs with the same hash. By the birthday math that takes about `2^128` tries for SHA-256: impossible in practice.

```js
import { createHash } from 'node:crypto';
createHash('sha256').update('hello').digest('hex');
// '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
```

Broken ones to recognize: **MD5** (practical collisions since 2004) and **SHA-1** (Google and CWI published a real collision, "SHAttered", in 2017). Fine as non-security checksums; never for signatures or certificates.

Two more rules:

- **Passwords need slow hashes** with a salt (bcrypt, scrypt, argon2), because SHA-256 is fast enough for attackers to try billions of guesses per second on GPUs (Day 47).
- **HMAC** (hash-based message authentication code) combines a secret key and a hash, so only someone with the key can produce a valid tag. That's how webhook signatures work (Day 18).

## Bloom filters: "definitely not" or "maybe"

Problem: a web crawler has seen 1 billion URLs. For each new URL, has it been crawled already? Storing all URLs (~50 bytes each) takes ~50 GB. A **Bloom filter** answers in about 1.2 GB, with a small, controllable error.

How it works:

1. Start with an array of `m` bits, all 0.
2. **Add** an item: compute `k` different hashes, each giving a position; set those `k` bits to 1.
3. **Check** an item: compute the same `k` positions. If **any** bit is 0 → **definitely not** added. If **all** are 1 → **probably** added (those bits might have been set by other items).

```text
m = 16 bits, k = 3
add "cat": positions 2, 7, 11      0010000100010000
add "dog": positions 4, 7, 14      0010100100010010
check "cow": positions 2, 4, 9     bit 9 is 0 -> definitely NOT present
check "emu": positions 2, 11, 14   all 1 -> "maybe" -> a false positive!
```

**No false negatives, some false positives.** You can't delete items (clearing a bit might erase someone else's); counting Bloom filters fix that with small counters.

```js
class BloomFilter {
  constructor(m, k) { this.m = m; this.k = k; this.bits = new Uint8Array(Math.ceil(m / 8)); }
  #positions(item) {                         // double hashing: h1 + i*h2
    const h1 = fnv1a(item), h2 = fnv1a(item + '#') | 1;
    return Array.from({ length: this.k }, (_, i) => ((h1 + i * h2) >>> 0) % this.m);
  }
  add(item) { for (const p of this.#positions(item)) this.bits[p >> 3] |= 1 << (p & 7); }
  mightHave(item) {
    return this.#positions(item).every(p => (this.bits[p >> 3] & (1 << (p & 7))) !== 0);
  }
}
const bf = new BloomFilter(10_000, 7);
bf.add('https://a.com'); bf.mightHave('https://a.com'); // true
bf.mightHave('https://b.com');                          // almost certainly false
```

Real uses: LSM-tree databases skip SSTables that can't contain a key (Day 19), crawlers skip seen URLs (Day 60), browsers once checked malicious URLs locally, CDNs avoid caching one-hit wonders.

## The math: sizing a Bloom filter

With `n` items, `m` bits and `k` hash functions:

```text
false-positive rate  p ≈ (1 - e^(-k·n/m))^k
best k               k = (m/n) · ln 2  ≈ 0.693 · (m/n)
bits per item        m/n = -ln(p) / (ln 2)^2 ≈ 1.44 · log2(1/p)
```

Example: 1 million items, 10 bits per item (`m` = 10 million bits = 1.25 MB):

```text
k = 10 × 0.693 ≈ 6.9 -> use 7
k·n/m = 7 × 1,000,000 / 10,000,000 = 0.7
e^(-0.7) ≈ 0.4966  ->  1 - 0.4966 = 0.5034
p ≈ 0.5034^7 ≈ 0.0082  -> about 0.8% false positives
```

Handy rule: **~10 bits per item gives ~1%**, and every extra ~4.8 bits per item cuts the rate by 10×. For the crawler: 1 billion URLs × 9.6 bits ≈ 9.6 Gbit ≈ 1.2 GB for 1%.

## HyperLogLog: counting distinct things in 12 KB

"How many **unique** visitors today?" Exact counting needs a set of every ID seen: memory grows with the answer. **HyperLogLog** estimates it with a fixed tiny memory.

The intuition: hash each ID to random-looking bits. Half of hashes start with `1`, a quarter with `01`, an eighth with `001`... Seeing a hash that starts with 20 zeros is a 1-in-a-million event, so if the *longest run of leading zeros* you've seen is 20, you've probably seen around `2^20 ≈ 1 million` distinct items. One such estimate is noisy, so HyperLogLog splits items into many buckets (registers) by the first bits of the hash and averages them with a harmonic mean.

Redis's implementation uses 16,384 registers in 12 KB per counter, with a standard error of `1.04 / √16384 ≈ 0.81%`, whether you count a thousand or a billion items. Duplicates don't change it: the same ID always produces the same hash.

## In an interview

Hashing shows up as a building block: "how do you detect duplicate URLs?", "how does the DB avoid reading every SSTable?", "how do you count unique viewers?", "are random 32-bit IDs OK?". Interviewers listen for the right tool and the numbers.

> "For duplicate detection over a billion URLs I'd put a Bloom filter in front of the URL store: at about 10 bits per item it's ~1.2 GB for a 1% false-positive rate, never gives false negatives, and a 'maybe' just falls through to an exact check. For unique visitor counts I'd use HyperLogLog: 12 KB per counter at under 1% error. And I'd avoid random 32-bit IDs: by the birthday bound you'd expect a collision after roughly 77,000 of them."

## Common mistakes

- **"Hashes are unique."** They aren't; collisions are guaranteed and arrive at about `√m` items.
- **Using CRC or MD5 for security.** Use SHA-256 or better for integrity against attackers, HMAC for authenticity.
- **Using SHA-256 for passwords.** Too fast. Use bcrypt/scrypt/argon2 with a salt.
- **Thinking Bloom filters can say "yes, definitely".** Only "no, definitely" or "maybe".
- **Using `hash % n` to pick servers** and being surprised that adding a server moves almost every key (Day 33 fixes it).

## Before moving on

- [ ] I can list four properties of a good hash function and write FNV-1a
- [ ] I can compute the birthday-bound collision chance for n items in m slots
- [ ] I can explain checksum vs cryptographic hash vs HMAC vs password hash
- [ ] I can explain why a Bloom filter has false positives but no false negatives
- [ ] I can size a Bloom filter for n items and a target false-positive rate
- [ ] I can describe the HyperLogLog intuition in two sentences

## Go deeper (optional)

- [Wikipedia: Birthday problem](https://en.wikipedia.org/wiki/Birthday_problem)
- [Wikipedia: Bloom filter](https://en.wikipedia.org/wiki/Bloom_filter)
- [Wikipedia: Cyclic redundancy check](https://en.wikipedia.org/wiki/Cyclic_redundancy_check)
- [Wikipedia: HyperLogLog](https://en.wikipedia.org/wiki/HyperLogLog)
- [SHAttered: the first SHA-1 collision](https://shattered.io/)
