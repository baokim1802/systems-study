# Design Typeahead Autocomplete

> Type "how to" into a search box and ten suggestions appear before your finger leaves the key. That box has to answer in tens of milliseconds, for every keystroke, for hundreds of millions of people. It's a beautiful lesson in precomputation: do the hard work once, offline, so each request is just a lookup.

## The big idea

Imagine a librarian who, every night, writes a little card for every possible beginning of a book title: on the card for "har" she writes the 5 most borrowed titles starting with "har" (*Harry Potter…*). During the day, when someone says "har…", she doesn't search the shelves. She just reads the card.

That's the whole trick:

- The cards are organized in a **trie** (pronounced "try", from re*trie*val): a tree where each edge is one character, so every node *is* a prefix.
- Each node stores its **top-k** suggestions, precomputed offline from search logs.
- Serving a request = walk down a few characters and return the stored list. No searching at request time.

## Step 1: Clarify requirements

**Functional**

- As the user types, return the **top 5** completions for the current prefix.
- Ranked by popularity (how often the full query was searched), with recent searches weighted more.
- Only prefix matching, lowercase English to start. (Spelling correction and personalization: mention as extensions.)
- Never suggest offensive or blocked phrases.

**Non-functional**

- **Fast:** results visible within ~100 ms of a keystroke, which is roughly where humans stop perceiving delay. That leaves the server only ~10–20 ms after network time.
- Highly available; stale-but-fast beats fresh-but-slow.
- Freshness: daily updates are fine, plus a way to surface breaking trends within minutes.

## Step 2: Back-of-the-envelope estimates

```text
DAU                      100M
Searches per user/day    10
Requests per search      ~6  (typed ~20 chars; debouncing skips many keystrokes)
Requests/day             100M × 10 × 6 = 6 billion
Average QPS              6e9 / 86,400 ≈ 69,000/s
Peak (×2)                ≈ 140,000/s
```

Data size: we don't need every query ever typed, only ones popular enough to suggest.

```text
Popular queries kept     10M, average 15 characters
Prefixes (upper bound)   10M × 15 = 150M; shared prefixes cut this a lot → say ~50M nodes
Per node: top-5 list ≈ 5 × 25 B = 125 B, plus key and overhead ≈ 200 B
Memory                   50M × 200 B ≈ 10 GB
```

10 GB fits in RAM on one server. So the problem isn't data size, it's **QPS and latency**: one server might do ~20k lookups/s, so we need ~7–10 replicas at peak, more for redundancy and regions.

## Step 3: API

```text
GET /v1/suggest?q=how%20to%20ma&limit=5&locale=en
→ 200 { "prefix": "how to ma", "suggestions": ["how to make pancakes", "how to make money", ...] }
Cache-Control: public, max-age=300
```

A plain `GET` with the prefix in the URL means browsers, CDNs and proxies can cache it (Day 14, Day 30). Short prefixes like `"a"` or `"how"` are the same for everyone, so they make great CDN cache keys.

## Step 4: Data model

Two artifacts:

```text
query_counts  (query, window, count)       built from search logs, e.g. daily
prefix_table  prefix → [top 5 queries]      the serving data, rebuilt periodically
```

`prefix_table` can be a trie in memory, or simply a key-value map (`"how to ma"` → list). A flat map is easy to shard and store in Redis or a local file; a trie saves memory because prefixes share nodes.

## Step 5: High-level design

```text
                     ┌────── OFFLINE (hourly/daily) ──────────────────────────────┐
 search logs ──▶ Kafka ──▶ aggregate counts ──▶ apply decay, filter blocklist ──▶  │
 (Day 34)                 (Spark/MapReduce)      build trie / prefix table         │
                     │                                    │ snapshot file           │
                     └────────────────────────────────────┼─────────────────────────┘
                                                          ▼
 browser ──▶ CDN (caches short prefixes) ──▶ LB ──▶ suggest servers (trie in RAM, replicas)
   ▲ debounce, cache, cancel stale requests                   ▲
   │                                          trending boost ─┘ (streaming, minutes)
```

The serving path never touches a database. Servers load a snapshot at startup and swap in a new one atomically when the builder publishes it (build the new trie on the side, then flip a pointer: blue-green for data, Day 50).

## Step 6: Deep dives

### Building a trie with top-k per node

```js
class TrieNode {
  constructor() { this.children = new Map(); this.top = []; } // top: [{q, count}]
}

function offer(node, q, count, k) {      // keep node.top as the k best, highest count first
  node.top.push({ q, count });
  node.top.sort((a, b) => b.count - a.count || a.q.localeCompare(b.q));
  if (node.top.length > k) node.top.pop();
}

class Autocomplete {
  constructor(k = 5) { this.root = new TrieNode(); this.k = k; }

  insert(query, count) {                 // called offline while building
    let node = this.root;
    offer(node, query, count, this.k);
    for (const ch of query) {
      if (!node.children.has(ch)) node.children.set(ch, new TrieNode());
      node = node.children.get(ch);
      offer(node, query, count, this.k); // every prefix node learns about this query
    }
  }

  suggest(prefix) {                      // called per request: O(prefix length)
    let node = this.root;
    for (const ch of prefix.toLowerCase()) {
      node = node.children.get(ch);
      if (!node) return [];
    }
    return node.top.map((t) => t.q);
  }
}

const ac = new Autocomplete(3);
[["how to tie a tie", 900], ["how to make pancakes", 1200], ["how tall is everest", 400],
 ["how to make money", 2000], ["hotels near me", 3000]].forEach(([q, c]) => ac.insert(q, c));
console.log(ac.suggest("how"));    // [ 'how to make money', 'how to make pancakes', 'how to tie a tie' ]
console.log(ac.suggest("ho"));     // [ 'hotels near me', 'how to make money', 'how to make pancakes' ]
console.log(ac.suggest("xyz"));    // []
```

This simple `insert` assumes each query is inserted once with its final count (true for an offline build).

Why precompute? Without the `top` lists, answering `"h"` means visiting every node under `"h"`, which could be millions of queries, and sorting them, on every keystroke. With them, a request costs `O(length of prefix)`: about 10 steps. The price is memory (k entries per node) and rebuild time, both fine offline.

### Ranking with decay

Raw all-time counts make old fads stick forever. Weight recent searches more: score = sum over days of `count_day × 0.9^(age in days)`. A query searched 1,000 times yesterday beats one searched 1,000 times a year ago.

### Freshness for trends

The daily build can't show a breaking news term at 9:05 a.m. Add a **streaming path**: count queries in a sliding window (e.g. last 10 minutes) with a stream processor; when a query's rate spikes far above its baseline, push it into a small "trending" table that servers merge into results. Merging is cheap: the top-5 from the trie plus a few trending candidates for that prefix.

### Latency budget

```text
keystroke → request sent         0–50 ms  (debounce wait, if any)
network round trip               20–50 ms (less from a nearby CDN edge)
server lookup                    < 1 ms   (in-memory)
render                           ~5 ms
```

The server is the cheap part; the network dominates. So the big wins are on the client and the edge:

- **Debounce** lightly (send after ~50 ms without a new key) to skip requests for fast typists.
- **Cache** responses in the browser: backspacing from "pancak" to "panca" shouldn't hit the network.
- **Cancel or ignore stale responses** (`AbortController`): if the reply for "pa" arrives after the reply for "pan", don't overwrite the newer list.
- **Serve short prefixes from the CDN**, since they're identical for everyone and the hottest keys.
- Some apps prefetch: the response for "pa" can include top results for "pan", "par", …

### Sharding when one machine isn't enough

If the data outgrows RAM (many languages, personalization), shard. Splitting by first letter is uneven: far more English queries start with "s" than "x". Better: shard by ranges chosen from real traffic (`a–al`, `am–az`, …) or by a hash of the first few characters, and replicate each shard. Every request goes to exactly one shard because the full prefix determines where it lives.

### Filtering

Apply a blocklist when building (never surface hate, personal data, or legally removed terms) and keep an emergency "remove now" list that servers check at request time, so a bad suggestion can disappear in seconds without waiting for the next build.

## Step 7: Bottlenecks and trade-offs

| Choice | Trade-off |
|---|---|
| Precomputed top-k per node | fast reads vs memory and rebuild time |
| Daily rebuild | simple and cheap vs stale (mitigated by a trending path) |
| CDN caching of prefixes | huge offload vs suggestions up to max-age stale |
| Trie vs flat prefix map | trie shares memory; flat map is simpler to shard and store |

## In an interview

Interviewers listen for: the trie, **precomputing top-k** instead of searching at request time, an offline pipeline from logs, a latency budget that shows where time goes, and client-side tricks. Model summary:

> "We aggregate search logs offline into decayed query counts, filter them, and build a trie where each node stores its top 5 completions. Snapshots are loaded into memory on stateless suggest servers, so a request is O(prefix length), well under a millisecond. ~140k QPS at peak needs only around ten replicas; short prefixes are cached at the CDN and in the browser, the client debounces and discards out-of-order responses, and a streaming job boosts trending queries within minutes."

## Common mistakes

- **Searching the subtree at request time.** That's millions of nodes for one-letter prefixes.
- **Querying a database per keystroke.** Keep serving data in memory.
- **Ignoring out-of-order responses**, so the list flickers back to an older prefix.
- **Sharding by first letter** and creating a giant "s" shard.
- **Forgetting the blocklist.** Autocomplete has embarrassed real companies.

## Before moving on

- [ ] I can build a trie that stores top-k at each node and explain why it's fast
- [ ] I can estimate QPS and memory for autocomplete
- [ ] I can draw the offline build pipeline and the online serving path
- [ ] I can list four client/edge optimizations and the latency budget
- [ ] I can explain how trending queries appear within minutes

## Go deeper (optional)

- [Trie on Wikipedia](https://en.wikipedia.org/wiki/Trie)
- [Autocomplete on Wikipedia](https://en.wikipedia.org/wiki/Autocomplete)
- [AbortController on MDN](https://developer.mozilla.org/en-US/docs/Web/API/AbortController)
