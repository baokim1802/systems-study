# Interview framework

Memory hook: **R**eal **E**ngineers **A**lways **D**raw **H**igh-level **D**iagrams **W**ell (Day 55). 45 minutes total.

## 1. Requirements (~5 min)
Functional: what must it do? Pick 2–4 core features.
Non-functional: scale, latency, availability vs consistency, durability.
Ask, don't assume. Write the list down.

## 2. Estimates (~5 min)
Users → QPS (avg and peak), read:write ratio, storage per year, bandwidth.
Only what changes the design.

## 3. API (~5 min)
```text
POST /urls        {longUrl} → {shortCode}
GET  /{shortCode} → 302 redirect
```

## 4. Data model (~5 min)
Entities, key fields, primary keys, access patterns → SQL or NoSQL and why.

## 5. High-level design (~10 min)
Client → load balancer → stateless app servers → cache → database. Add queues, CDN, blob storage, workers as needed. Walk one request through it.

## 6. Deep dives (~12 min)
The hard parts: scaling the hot path, sharding, consistency, failure handling. Let the interviewer steer.

## 7. Wrap-up (~3 min)
Bottlenecks, single points of failure, monitoring, what you'd do with more time. Name your trade-offs.

## Phrases that help
- "Let me make sure I understand the scope…"
- "I'll assume X; tell me if that's wrong."
- "The trade-off here is…"
- "What happens if this component fails?"
