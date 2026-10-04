# Design a Web Crawler

> Search engines, AI training sets, price trackers and archive sites all start with a crawler: a program that downloads a page, finds its links, and repeats, billions of times. It's a great interview problem because the simple loop hides hard questions about politeness, duplicates and scale.

## The big idea

Picture a librarian asked to collect every book in a giant city. She starts with a few addresses (the **seeds**). At each library she copies the books, writes down every address mentioned in them, and adds new addresses to her **to-visit list**. She keeps a **"been there" notebook** so she never visits the same library twice. And she's polite: she never sends 50 assistants into one small library at once, and she obeys any sign on the door that says "please don't copy the rare-books room" (that sign is **robots.txt**).

The real crawler is that loop:

```text
take URL from frontier → fetch it → store it → extract links → normalize → drop already-seen → add to frontier
```

The **URL frontier** is the to-visit list. Everything interesting is about doing this loop ~400 times per second without hammering any website, without re-crawling duplicates, and without getting stuck in infinite link mazes.

## Step 1: Clarify requirements

**Functional**

- Given seed URLs, crawl HTML pages for a search engine; store page content for later indexing.
- Re-crawl pages periodically to keep them fresh.
- Respect `robots.txt` and per-site rate limits.

**Non-functional**

- **Scale:** 1 billion pages per month.
- **Politeness:** never overload a website.
- **Robustness:** survive malformed HTML, slow servers, crawler traps, and machine crashes.
- **Extensible:** easy to add new content types later (images, PDFs).

Out of scope: the search index itself (Day 37), JavaScript rendering of pages (mention as an extension).

## Step 2: Back-of-the-envelope estimates

```text
Pages/second   = 1e9 / (30 × 86,400 s) = 1e9 / 2.59e6 ≈ 386 pages/s
Peak (×2)                                              ≈ 800 pages/s

Average HTML page ≈ 100 KB (uncompressed)
Storage/month  = 1e9 × 100 KB = 100 TB
Storage/year   = 1.2 PB raw; HTML compresses ~4-5× → roughly 250-300 TB/year
Download rate  = 386 pages/s × 100 KB ≈ 39 MB/s ≈ 310 Mbps average
```

How many fetches run at the same time? Use **Little's Law** from Day 52: `concurrency = throughput × latency`. If a fetch takes about 1 s on average (DNS + TCP + TLS + slow servers):

```text
in-flight fetches = 800 pages/s × 1 s = 800 concurrent connections
```

That is fine for a few machines using async I/O (Day 9: Node's event loop is good at exactly this). The real limits are elsewhere: politeness, DNS, and duplicate detection.

## Step 3: API (internal)

A crawler has no public API, but its components talk through clear interfaces:

```text
frontier.add(urls[], priority)       frontier.next(workerId) → url
fetcher.fetch(url) → { status, headers, body, finalUrl }
store.put(urlHash, compressedBody, metadata)
seen.checkAndAdd(urlHash) → boolean
```

## Step 4: Data model

```text
url_seen      Bloom filter + key-value store of normalized-URL hashes
pages         (url_hash PK, url, fetched_at, status, content_hash, storage_key)
host_state    (host PK, robots_rules, robots_fetched_at, crawl_delay_s, next_allowed_at)
content_seen  (content_hash PK) for exact-duplicate pages
```

Page bodies go to object storage (Day 36) in large compressed files (packing many pages per file avoids billions of tiny objects); the table stores where each one lives.

## Step 5: High-level design

```text
  seeds
    │
    ▼
┌─────────────────────────────── URL FRONTIER ───────────────────────────────┐
│  prioritizer ─▶ front queues (by priority) ─▶ back queues (one per host) ─▶│
│                                       heap of hosts ordered by next_allowed │
└────────────────────────────────────────┬───────────────────────────────────┘
                                         ▼
          ┌────────────┐          ┌─────────────┐        ┌───────────────┐
          │ DNS cache  │◀────────▶│  Fetchers   │───────▶│ robots.txt    │
          └────────────┘          └──────┬──────┘        │ cache         │
                                         ▼               └───────────────┘
                                  ┌─────────────┐
                                  │ Parser      │──▶ content dedup ──▶ object storage
                                  └──────┬──────┘     (hash seen?)
                                         ▼
                          link extractor + URL normalizer
                                         │
                                         ▼
                          URL-seen filter (Bloom filter) ──new──▶ back to frontier
```

## Step 6: Deep dives

### Politeness and the frontier

Rules of the road:

- Fetch `https://host/robots.txt` before crawling a host; cache it (for about a day) and obey `Disallow` rules and `Crawl-delay` if given.
- Keep **one connection per host** and wait between requests (say 1 s, or longer if the site is slow).

The classic Mercator design splits the frontier into **front queues** (by priority: important pages first) and **back queues** (one host per queue). A min-heap of hosts ordered by "next time I'm allowed to hit this host" lets a fetcher always grab the host that's ready soonest. Here's a small version:

```js
// Politeness scheduler: never hit the same host more often than delayMs.
class PoliteFrontier {
  constructor(delayMs) { this.delayMs = delayMs; this.queues = new Map(); this.nextAt = new Map(); }
  add(url) {
    const host = new URL(url).host;
    if (!this.queues.has(host)) { this.queues.set(host, []); this.nextAt.set(host, 0); }
    this.queues.get(host).push(url);
  }
  next(now) {                            // returns a URL whose host is ready, or null
    let best = null;
    for (const [host, q] of this.queues) {
      if (q.length && this.nextAt.get(host) <= now &&
          (best === null || this.nextAt.get(host) < this.nextAt.get(best))) best = host;
    }
    if (best === null) return null;
    this.nextAt.set(best, now + this.delayMs);
    return this.queues.get(best).shift();
  }
}

const f = new PoliteFrontier(1000);
["https://a.com/1", "https://a.com/2", "https://b.com/1"].forEach((u) => f.add(u));
console.log(f.next(0), f.next(0), f.next(0), f.next(1000));
// https://a.com/1  https://b.com/1  null  https://a.com/2
```

The linear scan is for clarity; a real frontier uses a heap so `next` is `O(log hosts)`.

### URL normalization

`HTTP://Example.com:80/a/../b#top` and `http://example.com/b` are the same page. Before checking "seen?", **normalize**: lowercase scheme and host, drop default ports (`:80`, `:443`), resolve `.` and `..`, remove the `#fragment`, and optionally sort query parameters and strip tracking ones like `utm_source`. JavaScript's `URL` class does much of this:

```js
const u = new URL("HTTP://Example.COM:80/a/../b?x=1#top");
u.hash = "";
console.log(u.href); // "http://example.com/b?x=1"
```

### Dedup with a Bloom filter

Over time the crawler sees maybe **10 billion distinct URLs**. Storing each 100-byte URL in a hash set would take 1 TB of RAM. A **Bloom filter** (Day 25) answers "definitely not seen" or "probably seen" in a fraction of that:

```text
bits per item  m/n = -ln(p) / (ln 2)^2      for false-positive rate p
p = 1%:        m/n = 4.605 / 0.4805 ≈ 9.6 bits per URL
memory         = 10e9 × 9.6 bits / 8 ≈ 12 GB
hash functions k = (m/n) × ln 2 ≈ 6.6 → 7
```

A false positive means we wrongly skip a URL we never crawled. Losing 1% of new URLs is acceptable for a crawler; a wrong "not seen" never happens, so we never crawl twice because of the filter.

### Content dedup

Different URLs often serve the same page (mirrors, `?sessionid=`). Hash the body (e.g. SHA-256) and skip pages whose hash is known. For **near**-duplicates (same article, different ad), use **SimHash**: a fingerprint where similar documents differ in only a few bits.

### DNS is a hidden bottleneck

Every new host needs a DNS lookup (Day 13), which can take tens to hundreds of milliseconds, and standard resolver libraries may be synchronous. Run a local caching resolver and cache per host.

### Crawler traps and robustness

An infinite calendar (`/calendar?month=2099-12` links to `2100-01` …) or session IDs in URLs can generate endless "new" pages. Defenses: max URL length, max depth, max pages per host per crawl, and noticing hosts whose URLs are many while their content hashes repeat. Also: timeouts on every fetch, limits on response size, and never trusting HTML to be well-formed.

### Distributing across machines

Partition the frontier by **hash(host)** with consistent hashing (Day 33). Each worker owns a set of hosts, so politeness stays a local decision: no cross-machine coordination per request. When a worker discovers a link to a host it doesn't own, it forwards the URL to the owner (batched). If a worker dies, its hosts move to neighbors on the ring and their frontier state is recovered from a durable log.

### Freshness

Not all pages change equally: a news homepage changes every minute, an old blog post never does. Track how often each page's content hash changes and schedule re-crawls proportionally, with `If-Modified-Since` / `ETag` requests (Day 14) so unchanged pages cost a `304` instead of a full download.

## Step 7: Bottlenecks and trade-offs

- **BFS vs priority:** pure breadth-first drowns in a few huge sites; prioritize by page importance and freshness.
- **Bloom filter vs exact set:** 12 GB with 1% missed URLs, vs ~1 TB exact.
- **Per-host politeness** caps how fast you can crawl a big site; parallelism comes from crawling many hosts at once.
- **JavaScript-heavy sites** need a headless browser, which is 10–100× more expensive per page; do it selectively.

## In an interview

Strong candidates name the frontier with politeness, robots.txt, normalization, URL and content dedup, traps, and host-based partitioning, and they back it with numbers. Model summary:

> "At 1B pages/month we need ~400 pages/s, ~800 at peak, about 800 concurrent fetches by Little's Law, and ~100 TB/month of raw HTML. The frontier has priority queues feeding per-host queues scheduled by a next-allowed-time heap for politeness, sharded by hash of host so one worker owns each host. Fetched pages are content-hashed for dedup and stored compressed in object storage; extracted links are normalized and checked against a ~12 GB Bloom filter before entering the frontier. We cache DNS and robots.txt and cap depth and pages per host to escape traps."

## Common mistakes

- **Forgetting politeness.** A naive crawler at 800 pages/s can take down a small site, and gets you blocked.
- **Checking 'seen' on raw URLs.** Without normalization the same page is crawled many times.
- **Assigning URLs to workers randomly.** Then no single worker can enforce a per-host delay.
- **Ignoring traps.** An infinite URL space will eat the whole crawl budget.
- **Using a Bloom filter where false positives are unacceptable**, or claiming it has false negatives (it doesn't).

## Before moving on

- [ ] I can draw the crawl loop and the frontier with front and back queues
- [ ] I can compute pages/s, storage and concurrency for a crawl target
- [ ] I can size a Bloom filter for a given number of URLs and error rate
- [ ] I can explain how to keep politeness when the crawler runs on 100 machines
- [ ] I can name three crawler traps or robustness problems and their fixes

## Go deeper (optional)

- [Web crawler on Wikipedia](https://en.wikipedia.org/wiki/Web_crawler)
- [robots.txt (Robots Exclusion Protocol) on Wikipedia](https://en.wikipedia.org/wiki/Robots.txt), standardized as RFC 9309
- [Bloom filter on Wikipedia](https://en.wikipedia.org/wiki/Bloom_filter)
- Heydon and Najork, *Mercator: A Scalable, Extensible Web Crawler* (1999)
