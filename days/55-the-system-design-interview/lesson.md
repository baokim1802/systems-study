# The System Design Interview

> A system design interview is 45 minutes of designing something huge, out loud, with a stranger. Nobody can design Twitter in 45 minutes, and nobody expects you to. What they score is *how you think*. A repeatable framework turns a scary blank whiteboard into seven familiar steps, and every case study from Day 56 to Day 66 will follow it.

## The big idea

Think of an architect meeting a client about a house. A bad architect immediately starts drawing a kitchen with marble counters. A good one asks: how many people live here? Do you work from home? What's the budget? Is there snow? Only then do they sketch the floor plan, and only after the client nods do they zoom into the tricky parts: the staircase, the plumbing.

The interview is the same meeting. The interviewer is the client, deliberately vague ("design a news feed"). Your job is to **turn ambiguity into requirements, requirements into numbers, numbers into a design, and the design into defended trade-offs**, all while thinking out loud.

## What interviewers are actually scoring

Most companies grade on roughly four things:

| Signal | What it looks like |
|---|---|
| **Problem navigation** | You clarify scope, pick what matters, and don't drown in details |
| **Solution design** | Your boxes and arrows actually work end to end for the requirements |
| **Technical depth and trade-offs** | You go deep on the hard parts and say *why* you chose X over Y |
| **Communication** | You drive, think aloud, check in, and adapt to hints |

Notice what's missing: "knows the one right answer". There isn't one. A reasonable design with clearly explained trade-offs beats a fancy design you can't justify.

## The framework: seven steps, 45 minutes

```text
 ┌───────────────────────────────────────────────────────────────┐
 │ 1. Requirements        5 min   what exactly are we building?   │
 │ 2. Estimates           5 min   how big? (QPS, storage, bandw.) │
 │ 3. API                 5 min   how do clients talk to it?      │
 │ 4. Data model          5 min   what do we store, keyed how?    │
 │ 5. High-level design  10 min   boxes and arrows, end to end    │
 │ 6. Deep dives         12 min   the 2–3 hardest parts           │
 │ 7. Wrap-up             3 min   bottlenecks, failures, next     │
 └───────────────────────────────────────────────────────────────┘
                                 = 45 min
```

A memory hook: **"Real Engineers Always Draw High-level Diagrams Well"** (Requirements, Estimates, API, Data, High-level, Deep dives, Wrap-up).

The minutes are a guide, not a law. If the interviewer wants to skip estimates, skip them. But glance at the clock: the most common failure is spending 25 minutes on requirements and boxes, and never reaching the deep dive where seniority shows.

### Step 1: Requirements (5 min)

Ask questions until you can write two short lists on the board.

**Functional requirements** — what the system *does*. Pick the 3–5 core features and say out loud what's out of scope.

**Non-functional requirements** — how *well* it must do it. Run through this checklist:

| Property | Question to ask | Reminds you of |
|---|---|---|
| Scale | How many users? Daily active? Reads vs writes? | Day 26 |
| Latency | How fast must the main action feel? p99 target? | Day 46, 52 |
| Availability | Is a few minutes of downtime acceptable? | Day 45 |
| Consistency | Must everyone see the newest data instantly, or is a few seconds stale OK? | Day 39, 40 |
| Durability | Can we ever lose data? | Day 36 |
| Other | Security, privacy, cost, global users, mobile clients? | Days 47, 51 |

Finish with a summary sentence: *"So: users can create and view pastes, 1M new pastes a day, reads 10x writes, reads must be fast and highly available, and a few seconds of staleness is fine. Analytics and editing are out of scope. Sound right?"* That check-in is a big communication signal.

### Step 2: Estimates (5 min)

Back-of-the-envelope math (Day 26), only the numbers that will **change a decision**:

```text
writes/s   = writes per day / 86,400   (≈ divide by 10^5)
reads/s    = writes/s × read:write ratio
peak       = average × 2–3 (or more for spiky products)
storage    = items per day × size × 365 × years
bandwidth  = requests/s × response size
```

Then say what the numbers *mean*: "120 reads per second is tiny, one database could do it; but 4 TB a year means blobs belong in object storage, not the database."

### Step 3: API (5 min)

Write the 2–4 main endpoints (Day 17). Include the important parameters and what they return. This forces precision: you can't hand-wave "the feed" once you write `GET /feed?cursor=…&limit=20`.

### Step 4: Data model (5 min)

List the main entities, their key fields, and **how they're looked up**. The access pattern decides the storage choice (Day 24): "we only ever fetch a paste by its id, so a key-value lookup is enough." Name the database type and why (Day 20, 23). Note the **partition key** if the data won't fit on one machine (Day 32).

### Step 5: High-level design (10 min)

Draw the boxes: clients, load balancer, services, caches, databases, queues, object storage, CDN. Then **walk one request through it**, for each main use case: "a write comes in here, goes to the API service, which stores the text in S3 and the metadata in the DB…" Keep it simple first. A working simple design beats a broken complex one; you'll add complexity in step 6.

### Step 6: Deep dives (12 min)

Pick the **2–3 hardest or most interesting parts** and go deep. Good candidates:

- The thing your estimates said is big (the hot path, the huge table, the bandwidth).
- The thing that makes this problem unique (fan-out for a feed, ordering for chat, exactly-once for payments).
- Whatever the interviewer hints at. *If they ask about something, that's the deep dive.*

For each: state the problem, give 2 options, compare them, choose one, and say what you give up. That pattern is the trade-off signal.

### Step 7: Wrap-up (3 min)

Unprompted, cover: the remaining bottlenecks, what happens when a component fails (Day 38), what you'd monitor (Day 46), and how the design would evolve at 10x scale. This shows you see the system as a living thing.

## A tiny worked example: "Design Pastebin"

A compressed run through all seven steps, to show the rhythm.

```text
1. REQUIREMENTS
   Functional: create paste (text up to 1 MB) → get a short link; view paste; optional expiry.
   Out of scope: accounts, editing, search.
   Non-functional: 1M new pastes/day, reads 10:1, reads < 100 ms p99,
                   highly available, durable, eventual consistency is fine.

2. ESTIMATES
   writes: 1,000,000 / 86,400 ≈ 12/s     reads: ≈ 120/s    peak ×3 → ~360 reads/s
   size: avg 10 KB → 10 GB/day → ~3.7 TB/year
   → traffic is small; storage growth says: put text in object storage.

3. API
   POST /pastes  { text, expiresInSeconds? }  → 201 { id, url }
   GET  /pastes/{id}                          → 200 { text, createdAt } | 404

4. DATA MODEL
   pastes: id (PK, 8-char random base62), object_key, created_at, expires_at
   Access pattern: get by id only → key-value / simple SQL table, small (≈ 365M rows/yr × ~100 B)

5. HIGH-LEVEL
   client → LB → stateless API servers → metadata DB
                                      ↘ object storage (paste text)
   reads: API → cache (Redis) → DB/S3;  popular pastes also cached at a CDN

6. DEEP DIVES
   a) ID generation: random 8-char base62 (62^8 ≈ 2.2 × 10^14) + retry on rare collision
      vs counter (guessable). Choose random: unguessable links.
   b) Expiry: lazy check on read + a daily cleanup job deleting expired objects.

7. WRAP-UP
   Bottleneck: none at this scale; at 100x, shard metadata by id hash.
   Failures: S3 is highly durable; DB has a standby in another AZ.
   Monitor: read p99, error rate, cache hit rate, storage growth.
```

Notice how each step feeds the next: the estimates justified object storage; the access pattern justified a key-value table.

## Phrases that help

- "Before I design anything, let me make sure I understand the requirements."
- "I'll assume X; tell me if you'd prefer something else." (Assume, state it, move on.)
- "Let me sanity-check with some quick numbers."
- "There are two options here. A gives us…, B gives us…. Given that we said reads matter most, I'd pick A."
- "I'll start simple and then we can find the bottlenecks."
- "Is there a part you'd like me to go deeper on?"

## In an interview

Everything above *is* the interview. Two extra tips:

- **Drive, but listen.** You lead the conversation, but interviewer hints are gold: "what if a celebrity posts?" means "deep dive on fan-out now".
- **Write as you go.** Keep the requirements, numbers and API visible on the board. They are your contract for the rest of the session, and you can point back to them when justifying decisions.

## Common mistakes

- **Jumping straight to technology** ("I'd use Kafka and Cassandra") before knowing the requirements.
- **Silent thinking.** The interviewer can only grade what you say aloud.
- **Estimates nobody uses.** Every number should lead to a "so…".
- **Over-engineering on day one.** Microservices, three databases and a service mesh for 12 writes per second is a red flag.
- **No trade-offs.** "I'd use NoSQL because it scales" says nothing. Say what you gain and what you give up.
- **Running out the clock** before the deep dives. Watch the time; it's fine to say "I'll keep the API brief so we have time for the interesting part".

## Before moving on

- [ ] I can list the seven steps in order, with a rough time for each
- [ ] I can recite the non-functional checklist (scale, latency, availability, consistency, durability)
- [ ] I can run Pastebin's estimates without looking
- [ ] I can describe how to choose deep dives and how to present a trade-off
- [ ] I know three phrases to check in with the interviewer

## Go deeper (optional)

- *System Design Interview – An Insider's Guide* by Alex Xu (Volumes 1 and 2)
- *Designing Data-Intensive Applications* by Martin Kleppmann, for the depth behind every deep dive
- [The System Design Primer](https://github.com/donnemartin/system-design-primer) (GitHub)
