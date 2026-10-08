# Content guide

How a day is written. Follow this when adding or editing days so the app (and `npm run check`) can read them.

## Files

Each day is one folder under `days/`:

```
days/
  14-http/
    lesson.md        the reading (markdown)
    day.json         title, track, minutes, summary and the interview questions
```

The folder name is `NN-slug`: a two-digit day number and a short kebab-case slug. Days are shown in folder-name order.

## day.json

```json
{
  "title": "HTTP: The Language of the Web",
  "track": "networking",
  "minutes": 35,
  "summary": "One sentence that says what you'll understand after today.",
  "questions": [
    {
      "id": "q1",
      "kind": "concept",
      "level": "warm-up",
      "prompt": "Markdown. Phrase it the way an interviewer would ask it.",
      "hint": "Markdown. A nudge, not the answer.",
      "keyPoints": [
        "What a strong answer must mention, one point per string.",
        "Specific and checkable, e.g. 'GET is safe and idempotent; POST is neither'."
      ],
      "answer": "A model answer in markdown, shown in the 💡 Solution tab once the day has feedback. Cover every key point."
    }
  ]
}
```

- `title` must be the same text as the `# ` heading at the top of `lesson.md`.
- `track` is one of the track ids below.
- `minutes` is the realistic reading time plus answering time (usually 30–50).
- `kind` is one of `concept`, `scenario`, `math`, `code`, `design`.
- `level` is one of `warm-up`, `core`, `stretch`.
- Question ids are `q1`, `q2`, … in order.
- 5 or 6 questions per day: one `warm-up`, three or four `core`, one `stretch`. Use `math` or `code` whenever the topic allows it (estimation, probability, a small function to write, a bug to find).
- `keyPoints` (3–6 per question) are what the AI grader checks the answer against, and what the learner sees after they answer. They are the most important part of a question: make them concrete.
- `prompt`, `hint`, `answer` are markdown strings. Code goes in fenced blocks (`\n```js\n...\n```\n` inside the JSON string).

## lesson.md

Written for a curious beginner: someone who can write a little JavaScript but never studied computer science. Explain every term the first time it appears. Build intuition first (an everyday analogy), then the real mechanism, then numbers, then how it shows up in interviews.

Shape (headings can vary to fit the topic):

```md
# <Title — same as day.json>

> One or two sentences: why this matters, in plain words.

## The big idea
An everyday analogy, then the real thing.

## How it actually works
The mechanism, step by step. ASCII diagrams welcome.

## <More sections as the topic needs>
Tables for comparisons. Small runnable JavaScript examples where code helps.

## The math (when the topic has some)
Work an example step by step, with real numbers.

## In an interview
How this topic shows up, what interviewers listen for, a good one-paragraph answer.

## Common mistakes
- Misconceptions beginners have, and the fix.

## Before moving on
- [ ] I can explain … in two sentences
- [ ] I can …

## Go deeper (optional)
- Well-known, stable resources only (Wikipedia pages, MDN, official docs, classic papers or books such as *Designing Data-Intensive Applications*). Never invent a URL.
```

Length: roughly 150–260 lines. Dense with understanding, no filler.

### Markdown the app understands

The renderer is small. Use only:

- `#`–`######` headings, paragraphs, `**bold**`, `*italic*`, `` `code` ``, `[links](https://…)`, `~~strike~~`
- bullet and numbered lists (nesting by two spaces), task lists `- [ ]`
- tables with a header row
- `>` blockquotes
- fenced code blocks. ` ```js ` gets syntax highlighting; use ` ```text ` for ASCII diagrams, shell output and math
- `---` horizontal rules
- raw HTML blocks such as `<details><summary>Answer</summary>…</details>` (keep the whole block without blank lines inside)

No images, no LaTeX. Write math in code blocks or inline code: `2^10 = 1024`, `log2(1,000,000) ≈ 20`.

## Tracks

| id | Track |
|---|---|
| `foundations` | 🧠 How a computer works |
| `networking` | 🌐 Networking |
| `data` | 🗄️ Data & databases |
| `scale` | 🧱 Building blocks of scale |
| `distributed` | 🕸️ Distributed systems |
| `production` | 🛠️ Production: security, ops & cloud |
| `design` | 🏗️ Design case studies |

## Curriculum

| Day | Folder | Track | Topic and what to cover |
|---|---|---|---|
| 01 | `01-start-here` | foundations | How to use this space; what "system design" is; how to answer interview questions (think aloud, trade-offs, numbers) |
| 02 | `02-bits-bytes-and-number-systems` | foundations | Binary, hex, powers of two, two's complement, overflow, floats and why `0.1 + 0.2 !== 0.3` |
| 03 | `03-text-and-encoding` | foundations | ASCII, Unicode, UTF-8 byte layout, JS strings are UTF-16, base64, URL encoding |
| 04 | `04-how-a-cpu-runs-code` | foundations | Fetch–decode–execute, registers, clock speed, cores, pipelining, branch prediction, machine code vs assembly |
| 05 | `05-memory-and-latency-numbers` | foundations | Registers → caches → RAM → SSD → network; latency numbers every programmer should know; locality |
| 06 | `06-processes-threads-and-the-os` | foundations | Kernel vs user space, syscalls, processes, threads, scheduling, context switches, virtual memory |
| 07 | `07-concurrency-races-and-locks` | foundations | Race conditions, atomicity, mutexes, deadlock (four conditions), async vs parallel, JS single thread + workers |
| 08 | `08-storage-disks-and-filesystems` | foundations | HDD vs SSD, blocks, files and inodes, page cache, fsync and durability, sequential vs random IO |
| 09 | `09-how-javascript-runs` | foundations | Compilers vs interpreters, JIT, V8, call stack, event loop, microtasks vs macrotasks, Node's libuv |
| 10 | `10-memory-management-and-garbage-collection` | foundations | Stack vs heap, references, mark-and-sweep, generational GC, memory leaks in JS, GC pauses in servers |
| 11 | `11-how-the-internet-works` | networking | Packets, IP addresses, routers, layers (OSI/TCP-IP), NAT, ports, private vs public IPs, IPv4 vs IPv6 |
| 12 | `12-tcp-and-udp` | networking | Three-way handshake, reliability, ordering, flow/congestion control, head-of-line blocking, when to use UDP |
| 13 | `13-dns` | networking | Resolvers, root/TLD/authoritative servers, record types, TTL and caching, DNS-based load balancing |
| 14 | `14-http` | networking | Requests/responses, methods, status codes, headers, cookies, caching headers, HTTP/1.1 vs 2 vs 3 |
| 15 | `15-cryptography-and-tls` | networking | Symmetric vs asymmetric, Diffie–Hellman with small numbers, toy RSA math, certificates, the TLS handshake |
| 16 | `16-what-happens-when-you-type-a-url` | networking | Capstone: browser → DNS → TCP → TLS → HTTP → server → render, with timings |
| 17 | `17-apis-rest-graphql-grpc` | networking | REST design, pagination, versioning, GraphQL, gRPC/protobuf, choosing between them |
| 18 | `18-real-time-communication` | networking | Polling, long polling, server-sent events, WebSockets, webhooks; connection counts at scale |
| 19 | `19-data-structures-behind-databases` | data | Append-only log, hash index, B-trees, LSM trees and SSTables, write vs read amplification |
| 20 | `20-relational-databases-and-sql` | data | Tables, keys, joins, SQL basics with examples, query planning, why relational is the default |
| 21 | `21-indexes-and-query-performance` | data | How an index works, composite indexes, covering indexes, EXPLAIN, cost of indexes on writes, `log n` math |
| 22 | `22-transactions-and-isolation` | data | ACID, write-ahead log, isolation levels, dirty reads, lost updates, write skew, MVCC, locking |
| 23 | `23-nosql-families` | data | Key-value, document, wide-column, graph, time-series; what each is good at; SQL vs NoSQL trade-offs |
| 24 | `24-data-modeling` | data | Normalization vs denormalization, access patterns first, one-to-many/many-to-many, modeling a real app |
| 25 | `25-hashing-checksums-and-bloom-filters` | data | Hash functions, collisions, birthday paradox math, checksums/CRC, cryptographic hashes, Bloom filter false-positive math, HyperLogLog idea |
| 26 | `26-back-of-the-envelope-estimation` | scale | Powers of ten, QPS from DAU, storage per year, bandwidth, peak vs average, worked examples |
| 27 | `27-scaling-up-and-out` | scale | Vertical vs horizontal, stateless services, sessions, the path from one server to many |
| 28 | `28-load-balancing` | scale | L4 vs L7, round robin, least connections, hashing, health checks, sticky sessions, global LB |
| 29 | `29-caching` | scale | Cache-aside, write-through, write-back, TTLs, invalidation, LRU (implement it), thundering herd, hit-rate math |
| 30 | `30-cdns-and-the-edge` | scale | How CDNs work, push vs pull, cache keys, edge compute, latency math by distance (speed of light) |
| 31 | `31-replication` | scale | Leader–follower, multi-leader, leaderless, sync vs async, replication lag anomalies, failover |
| 32 | `32-sharding` | scale | Partitioning by range vs hash, hot spots, rebalancing, cross-shard queries, choosing a shard key |
| 33 | `33-consistent-hashing` | scale | Why `hash % n` breaks, the ring, virtual nodes, implement a small ring in JS, keys-moved math |
| 34 | `34-queues-and-async-processing` | scale | Message queues, pub/sub, Kafka-style logs, consumer groups, backpressure, dead-letter queues |
| 35 | `35-rate-limiting` | scale | Token bucket (implement it), leaky bucket, fixed/sliding windows, distributed rate limiting with Redis |
| 36 | `36-object-storage-and-files` | scale | Blob storage (S3), metadata vs data, multipart upload, presigned URLs, durability nines, erasure coding idea |
| 37 | `37-search-and-inverted-indexes` | scale | Tokenizing, inverted index (build one in JS), TF-IDF intuition, ranking, Elasticsearch-style sharding |
| 38 | `38-why-distributed-systems-are-hard` | distributed | Partial failure, the fallacies of distributed computing, timeouts, network partitions, split brain |
| 39 | `39-cap-and-pacelc` | distributed | CAP stated correctly, what "consistency" and "availability" mean there, PACELC, real system examples |
| 40 | `40-consistency-models` | distributed | Linearizability, sequential, causal, read-your-writes, eventual; quorum math `R + W > N` |
| 41 | `41-time-and-clocks` | distributed | Why wall clocks lie, NTP, monotonic clocks, Lamport clocks and vector clocks (implement), TrueTime idea |
| 42 | `42-consensus-and-leader-election` | distributed | The consensus problem, Raft (terms, elections, log replication) intuitively, quorums, ZooKeeper/etcd |
| 43 | `43-retries-idempotency-and-exactly-once` | distributed | Timeouts, retries with exponential backoff + jitter (code), idempotency keys, at-least-once, exactly-once myths |
| 44 | `44-distributed-transactions-and-sagas` | distributed | Two-phase commit and its failure modes, sagas with compensations, outbox pattern |
| 45 | `45-availability-math-and-slos` | distributed | Nines, downtime per year, serial vs parallel availability math, SLI/SLO/SLA, error budgets |
| 46 | `46-observability` | production | Logs, metrics, traces, percentiles (p50/p99) and why averages lie, compute a percentile, alerting |
| 47 | `47-authentication-and-authorization` | production | Password hashing (bcrypt/argon2), sessions vs tokens, JWT structure, OAuth 2.0 / OIDC flow, RBAC |
| 48 | `48-web-security-vulnerabilities` | production | SQL injection, XSS, CSRF, SSRF, CORS, secrets handling, least privilege; spot the bug in code |
| 49 | `49-containers-and-kubernetes` | production | VMs vs containers, images and layers, Docker basics, Kubernetes pods/deployments/services, autoscaling |
| 50 | `50-ci-cd-and-safe-deploys` | production | CI pipelines, tests in CI, blue-green, canary, rolling deploys, feature flags, rollbacks, DB migrations |
| 51 | `51-cloud-fundamentals-and-cost` | production | Regions and zones, IaaS/PaaS/serverless, managed services, cost estimation math, multi-region trade-offs |
| 52 | `52-performance-and-queueing-theory` | production | Latency vs throughput, Little's Law, utilization and queueing delay, Amdahl's law, profiling |
| 53 | `53-git-internals` | production | Content-addressed storage, blobs/trees/commits, branches as pointers, merging vs rebasing |
| 54 | `54-how-ai-systems-are-served` | production | What a model is, tokens, inference on GPUs, batching, embeddings, vector search, RAG architecture, cost/latency math |
| 55 | `55-the-system-design-interview` | design | A repeatable framework: requirements, estimates, API, data model, high-level design, deep dives, trade-offs; time budget |
| 56 | `56-design-a-url-shortener` | design | Full walkthrough; base62 math, ID generation (counters, Snowflake), caching reads, analytics |
| 57 | `57-design-a-news-feed` | design | Fan-out on write vs read, celebrities, ranking, feed storage, pagination |
| 58 | `58-design-a-chat-app` | design | WebSocket gateways, message storage and ordering, delivery receipts, presence, group chat, offline push |
| 59 | `59-design-a-video-platform` | design | Upload pipeline, transcoding, adaptive bitrate streaming, CDN, storage and bandwidth math |
| 60 | `60-design-a-web-crawler` | design | URL frontier, politeness, dedup with hashing/Bloom filters, scale math, robots.txt |
| 61 | `61-design-a-notification-system` | design | Push/email/SMS fan-out, queues, retries, user preferences, dedup, rate limits |
| 62 | `62-design-typeahead-autocomplete` | design | Tries (build one), top-k per prefix, precomputation, caching, latency budget |
| 63 | `63-design-a-ride-sharing-service` | design | Location updates at scale, geohashing/quadtrees, matching, trip state machine |
| 64 | `64-design-collaborative-editing` | design | Google Docs style: OT vs CRDTs intuition, presence, conflict resolution, offline |
| 65 | `65-design-a-payment-system` | design | Idempotency, double-entry ledger, reconciliation, exactly-once money movement, PSPs |
| 66 | `66-design-a-distributed-key-value-store` | design | Capstone: partitioning, replication, quorums, vector clocks, gossip, hinted handoff, Merkle trees |
| 67 | `67-mock-interview-and-whats-next` | design | A full mock prompt to do timed, self-review checklist, what to learn next |

Later days can refer back to earlier ones ("remember Day 12, TCP's handshake…"). That helps learning stick.
