# Design a URL Shortener

> The classic first system design question (think bit.ly or TinyURL). It looks trivial, a map from short code to long URL, but it touches estimation, ID generation, caching, redirects and analytics. Today we run it through the Day 55 framework, step by step.

## The big idea

A coat check. You hand over a long, bulky coat (a 200-character URL); you get a small ticket with a number (`sho.rt/aZ3k9Q1`). Later, anyone with the ticket gets the coat back. The interesting questions are about the tickets: how do you print unique ticket numbers when twenty cloakroom attendants work in parallel, and how do you serve a million ticket-holders an hour without a line?

We'll follow the seven steps from Day 55: **Requirements, Estimates, API, Data model, High-level design, Deep dives, Wrap-up.**

## Step 1: Requirements (5 min)

Questions to ask, and the answers we'll assume:

- *Who creates links?* Anyone; logged-in users can see their links' stats.
- *Can users pick a custom alias?* Yes, optionally.
- *Do links expire?* Optional expiry; default never.
- *Can links be edited or deleted?* Deleted, yes. Edited, no (out of scope).
- *Do we need click analytics?* Yes: clicks per link over time, but they can be a few minutes behind.

**Functional**

1. Given a long URL, create a short URL (optionally with a custom alias and expiry).
2. Visiting a short URL redirects to the long URL.
3. Link owners can see click counts.

**Non-functional**

- Scale: 100M new links per month; reads far outnumber writes (assume 100:1).
- Redirects are **fast** (p99 under ~50 ms server time) and **highly available**: a broken short link breaks someone's tweet, email or printed poster forever.
- Short codes should be **short** and **not guessable** in sequence (people shouldn't be able to enumerate private links).
- Durability: a link, once created, must never be lost.
- Consistency: a new link should work within a second or so of creation; analytics can lag minutes.

## Step 2: Estimates (5 min)

```text
writes:   100M / month ÷ (30 × 86,400 s) ≈ 40 /s          peak ×3 ≈ 120 /s
reads:    40 × 100                       ≈ 4,000 /s       peak ×3 ≈ 12,000 /s
links in 5 years: 100M × 12 × 5          = 6 billion
storage:  6B × ~500 bytes (URL + metadata) = 3 TB        (×3 replicas ≈ 9 TB)
reads/day: 4,000 × 86,400                ≈ 350 million
```

What the numbers tell us:

- **Writes are small** (40/s): any database can take them.
- **Reads are the hot path** (12k/s at peak): this is a caching problem.
- **3 TB, 6 billion rows**: more than one comfortable database node over time, so plan for sharding or a key-value store that partitions automatically.

How long must codes be? Using base62 (the characters `0-9a-zA-Z`):

```text
62^6 = 56,800,235,584        ≈ 57 billion   > 6 billion  ✓ six characters suffice
62^7 = 3,521,614,606,208     ≈ 3.5 trillion   lots of headroom
```

We'll use **7 characters**: plenty of room for decades and sparse enough to make guessing hard.

## Step 3: API (5 min)

```text
POST /api/links
  body: { "longUrl": "https://…", "customAlias": "spring-sale"?, "expiresAt": "2027-01-01"? }
  → 201 { "code": "aZ3k9Q1", "shortUrl": "https://sho.rt/aZ3k9Q1" }
  → 409 if customAlias is taken;  400 if longUrl is invalid
  (auth optional; rate-limited per user/IP to stop spam, Day 35)

GET /{code}
  → 302 Found, header  Location: https://the-long-url…
  → 404 if unknown or expired

GET /api/links/{code}/stats?from=…&to=…
  → 200 { "total": 18234, "byDay": [ … ] }

DELETE /api/links/{code}  (owner only)
```

**301 or 302?** A **301 Moved Permanently** lets browsers cache the redirect, so repeat clicks never reach us: less load, but we lose analytics and can't delete or expire the link for those users. A **302 Found** (temporary) means every click comes to us. Since analytics and deletion are requirements, choose **302**, and say out loud that 301 is the cheaper option if analytics weren't needed.

## Step 4: Data model (5 min)

```text
links
  code         string(7)   PRIMARY KEY      ← the only lookup on the hot path
  long_url     text
  user_id      bigint, nullable
  created_at   timestamp
  expires_at   timestamp, nullable

clicks (event stream, not the main DB)
  code, timestamp, country, referrer, user_agent
```

The hot-path access pattern is one thing: **get `long_url` by `code`**. That's a pure key-value lookup, which suits a partitioned key-value store (DynamoDB, Cassandra) or sharded SQL keyed by `code` (Day 32). A secondary index on `user_id` serves "list my links". Hash-partitioning by `code` spreads the load evenly.

## Step 5: High-level design (10 min)

```text
                         ┌──────────────┐
  POST /api/links ──────►│ Write service │──► ID generator (deep dive 1)
                         └──────┬───────┘
                                ▼
                         ┌──────────────┐
                         │  links DB    │  (sharded by code, replicated across AZs)
                         └──────▲───────┘
                                │ miss
  GET /{code} ──► LB ──► ┌──────┴───────┐     ┌─────────┐
                         │ Redirect svc │◄───►│  Cache  │  (Redis)
                         └──────┬───────┘     └─────────┘
                                │ async click event
                                ▼
                         ┌──────────────┐     ┌──────────────┐
                         │ Queue (Kafka)│────►│ Analytics    │──► stats store
                         └──────────────┘     │ aggregator   │
                                              └──────────────┘
```

Walk through both paths:

- **Create:** the write service validates the URL, gets a new code, inserts the row, returns the short URL.
- **Redirect:** the redirect service checks the cache; on a miss it reads the DB and fills the cache (cache-aside, Day 29). It returns a 302 *immediately* and publishes a click event to a queue without waiting, so analytics never slow redirects down.

Reads and writes are separate services because they scale very differently (12k/s vs 120/s).

## Step 6: Deep dives (12 min)

### Deep dive 1: generating unique short codes

Four options. This comparison *is* the heart of the interview.

**A. Hash the long URL** (e.g. MD5) and take the first 7 base62 characters.

- Same long URL → same code (free dedup).
- Truncating a hash causes **collisions**: two different URLs, same 7 characters. You must check the DB and retry with a salt. And two users shortening the same URL now share stats and expiry, which may be wrong.

**B. A global counter, encoded in base62.** Counter 125 becomes `"21"`:

```js
const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

function encode(n) {
  if (n === 0) return "0";
  let s = "";
  while (n > 0) {
    s = ALPHABET[n % 62] + s;   // last digit first
    n = Math.floor(n / 62);
  }
  return s;
}

function decode(s) {
  let n = 0;
  for (const ch of s) n = n * 62 + ALPHABET.indexOf(ch);
  return n;
}

console.log(encode(125));            // "21"   (2 × 62 + 1)
console.log(encode(1000000000));     // "15FTGg"
console.log(decode("15FTGg"));       // 1000000000
console.log(encode(56800235583));    // "ZZZZZZ" (the largest 6-char code)
```

- No collisions ever, short codes.
- A single counter is a bottleneck and single point of failure. Fix: a **range allocator** (a "ticket server"): each write server reserves a block of, say, 10,000 numbers at a time from a small coordinated store (a DB row or ZooKeeper/etcd, Day 42), then hands them out locally. If a server crashes, its unused numbers are skipped; that's fine.
- Sequential codes are **guessable** (`…aZ3k9Q`, `…aZ3k9R`). Fix: scramble the number before encoding, e.g. a reversible bijection like multiplying by a large constant that shares no factor with `62^7` (so no two IDs collide), modulo `62^7`, so consecutive IDs look random.

**C. Snowflake IDs.** Twitter's scheme packs a 64-bit ID with no coordination:

```text
| 1 bit unused | 41 bits: ms since epoch | 10 bits: machine id | 12 bits: sequence |
 41 bits of ms  = 2^41 ms ≈ 69.7 years
 12 bits        = 4,096 IDs per ms per machine
 10 bits        = 1,024 machines
```

- Great for unique, time-sortable IDs in distributed systems (you'll reuse it for posts and messages on Days 57 and 58).
- But a 64-bit number in base62 needs up to **11 characters** (`62^10 ≈ 8.4 × 10^17 < 2^63 ≈ 9.2 × 10^18`). Too long for a *short* URL. A good catch to mention.

**D. Random 7-character code, insert if absent.**

- Simple and unguessable. Use a conditional insert ("insert only if `code` doesn't exist") and retry on conflict.
- Collision math after 6 billion links: `6 × 10^9 / 3.5 × 10^12 ≈ 0.17%` chance per attempt, so retries are rare and cheap.

**Decision:** B with range allocation and scrambling, or D. Both are defensible; say which and why. Custom aliases go through the same table with the same conditional insert (409 if taken).

### Deep dive 2: making redirects fast and available

- **Cache.** Link popularity is extremely skewed: a few links get most clicks. Caching the hottest 20 million links at ~500 bytes each is ~10 GB, which fits in one Redis node (use a replica for availability). With a 90%+ hit rate, the database sees only ~1,200 reads/s at peak.
- **Negative caching.** Cache "not found" briefly too, so bots hammering random codes don't hit the DB.
- **Edge.** For viral links, a CDN or edge worker (Day 30) can serve the 302 itself with a short TTL.
- **Expiry.** Check `expires_at` on read; a background job deletes expired rows later.
- **Availability.** Stateless redirect servers in multiple AZs behind the load balancer; replicated DB; the redirect path never depends on the analytics pipeline.

### Deep dive 3: analytics without slowing redirects

Each redirect publishes `{code, time, country, referrer}` to Kafka (Day 34) asynchronously. A stream processor aggregates counts per code per minute and writes them to a stats store (a time-series or columnar database). At 12,000 clicks/s, writing one DB row per click to the main database would be wasteful; pre-aggregating turns 720,000 events per minute into far fewer counter updates. If the analytics pipeline is down, redirects still work, and events wait in the queue.

## Step 7: Wrap-up (3 min)

- **Bottlenecks:** the cache tier on viral links (mitigate with edge caching and replicas); ID ranges if the allocator store is down (servers keep handing out their current block).
- **Failures:** cache node loss shifts load to the DB (warm the cache, rate-limit misses); a region outage needs a second region with replicated links for redirects to keep working.
- **Abuse:** shorteners are used to hide phishing links. Check new URLs against a blocklist, rate-limit creation.
- **Monitoring:** redirect p99, 404 rate, cache hit ratio, creation rate, queue lag.
- **At 10x:** more shards for links, more cache replicas, more partitions for click events. Nothing fundamental changes, which is a sign of a good design.

## Common mistakes

- **Spending the whole interview on hashing.** ID generation matters, but so do caching and analytics.
- **Writing a DB row per click synchronously** in the redirect path.
- **Choosing 301 without noticing it kills analytics.**
- **Forgetting that truncated hashes collide.**
- **Proposing Snowflake without noticing the codes become 11 characters.**

## Before moving on

- [ ] I can do the estimates: ~40 writes/s, ~4,000 reads/s, ~3 TB in 5 years
- [ ] I can explain why 7 base62 characters are enough (`62^7 ≈ 3.5 trillion`)
- [ ] I can write base62 encode/decode
- [ ] I can compare hash, counter + ranges, Snowflake and random codes
- [ ] I can explain 301 vs 302 and how analytics stays off the hot path

## Go deeper (optional)

- [URL shortening (Wikipedia)](https://en.wikipedia.org/wiki/URL_shortening)
- [Snowflake ID (Wikipedia)](https://en.wikipedia.org/wiki/Snowflake_ID)
- [HTTP 302 on MDN](https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/302)
- *System Design Interview – An Insider's Guide*, Volume 1, by Alex Xu (chapter on URL shorteners)
