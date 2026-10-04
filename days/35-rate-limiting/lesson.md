# Rate Limiting

> Every public system needs a bouncer at the door. Rate limiting decides how many requests each client may make, so one buggy script, greedy customer or attacker can't take the service down for everyone else.

## The big idea

A theme-park ride lets 40 people on every 5 minutes. It doesn't matter how long the queue is: the ride runs at its own safe rate, and the line waits. A rate limiter does the same for an API: "this API key may make **100 requests per minute**; request 101 gets told to come back later."

Why systems need it:

- **Protection**: a client in an infinite retry loop can send thousands of requests per second.
- **Fairness**: one big customer shouldn't eat all the capacity.
- **Cost**: each call might cost you money (an SMS, an AI model call).
- **Security**: slowing down password guessing and scraping.

When a request is rejected, HTTP has a dedicated answer: status **`429 Too Many Requests`**, usually with a `Retry-After` header saying how many seconds to wait. Many APIs also send headers like `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset` so well-behaved clients can slow down before they hit the wall.

## Where the limiter lives

```text
client ──▶ [ API gateway / load balancer ] ──▶ [ app servers ] ──▶ DB
                 ▲ rate limit here                 ▲ or here
                 │                                 │
            shared counter store (e.g. Redis) ◀────┘
```

You choose a **key** to count by: user id, API key, IP address, or a combination such as `(userId, endpoint)`. IP limits are easy but unfair (a whole office or mobile carrier can share one IP behind NAT, Day 11). Limits per API key or user are better when the client is logged in.

## Algorithm 1: Fixed window counter

Split time into windows (e.g. each calendar minute). Keep one counter per key per window. If the counter is under the limit, increment and allow.

```text
limit 100/min
12:00:00–12:00:59  count = 100  → next one rejected
12:01:00           new window, count resets to 0
```

Simple and cheap: one integer per key. The flaw is the **boundary burst**: a client can send 100 requests at 12:00:59 and 100 more at 12:01:00, so 200 requests in about one second, double the intended rate.

## Algorithm 2: Sliding window log

Store the timestamp of every request. On a new request, drop timestamps older than 60 s and count the rest. Perfectly accurate, but memory is one entry **per request**: a limit of 10,000/min means up to 10,000 timestamps per client.

## Algorithm 3: Sliding window counter

A clever compromise. Keep only the counts for the **current** and **previous** fixed windows, and assume the previous window's requests were spread evenly:

```text
estimate = prevCount × (fraction of previous window still inside the last 60 s)
         + currCount

limit 100/min, we are 15 s into the current minute
prevCount = 80, currCount = 30
estimate  = 80 × (45/60) + 30 = 60 + 30 = 90   → allowed (90 < 100)
```

Two integers per key, and it smooths away most of the boundary burst. Cloudflare has written about using this approach at scale.

## Algorithm 4: Token bucket (the one to know)

Picture a bucket that holds up to `capacity` tokens. Tokens drip in at `refillRate` per second; extra tokens overflow and are lost. Each request takes one token. No token, no entry.

```text
capacity = 10, refillRate = 2 tokens/s

t=0s   bucket full (10). Client sends 10 requests at once → all allowed, bucket 0
t=0s   11th request → rejected (429)
t=1s   2 tokens have dripped in → 2 more requests allowed
steady state: 2 requests/s, with bursts of up to 10 after a quiet period
```

Two knobs, two meanings: **capacity = how big a burst you tolerate**, **refill rate = the long-run average**. That's why token bucket is used by AWS API Gateway, Stripe and many others.

You don't need a timer to add tokens. Just compute how many *would* have dripped in since the last request:

```js
class TokenBucket {
  constructor(capacity, refillPerSec) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.tokens = capacity;          // start full
    this.last = Date.now();          // ms
  }

  tryRemove(now = Date.now()) {
    const elapsedSec = (now - this.last) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillPerSec);
    this.last = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;                   // allowed
    }
    return false;                    // 429
  }
}

const bucket = new TokenBucket(3, 1);   // burst of 3, then 1 per second
console.log(bucket.tryRemove(), bucket.tryRemove(), bucket.tryRemove(), bucket.tryRemove());
// true true true false
```

Hidden clocks make code hard to test, so here's the same logic with time passed in explicitly. (Mixing clocks is a real bug source: if the bucket starts at `Date.now()` and you then pass `now = 0`, elapsed time goes negative.)

```js
function makeBucket(capacity, refillPerSec, start) {
  let tokens = capacity, last = start;
  return (now) => {
    tokens = Math.min(capacity, tokens + ((now - last) / 1000) * refillPerSec);
    last = now;
    if (tokens >= 1) { tokens -= 1; return true; }
    return false;
  };
}

const allow = makeBucket(3, 1, 0);
console.log(allow(0), allow(0), allow(0), allow(0)); // true true true false
console.log(allow(1000));                            // true  (1 token refilled)
console.log(allow(1500));                            // false (only 0.5 token)
```

Per key you store just two numbers: `tokens` and `last`.

## Algorithm 5: Leaky bucket

Requests pour into a bucket (a queue) of fixed size, and **leak out at a constant rate** to be processed. If the bucket is full, new requests spill (are rejected). The output is perfectly smooth, which is good for protecting something fragile (a legacy service that can only take 50 requests/s), but bursts are delayed rather than served quickly.

| Algorithm | Memory per key | Bursts | Accuracy | Notes |
|---|---|---|---|---|
| Fixed window | 1 counter | up to 2× at boundary | rough | simplest |
| Sliding log | 1 timestamp per request | none | exact | memory heavy |
| Sliding window counter | 2 counters | smoothed | close approximation | great default |
| Token bucket | 2 numbers | allowed up to capacity | exact for its model | most popular |
| Leaky bucket | a queue | absorbed, output smoothed | exact | constant output rate |

## Distributed rate limiting with Redis

With 20 app servers, a counter in each server's memory isn't enough: a client spread across servers by the load balancer (Day 28) gets 20× the limit. So the counters move to a shared, fast store, usually **Redis** (an in-memory key-value server answering in well under a millisecond on a local network).

Fixed window in Redis is two commands:

```text
INCR   rl:user42:202609301201        → returns the new count, e.g. 37
EXPIRE rl:user42:202609301201 60     → key deletes itself after the window
if count > 100 → reject
```

`INCR` is **atomic** (Day 7): two servers incrementing at the same moment can't both read 99 and both write 100. For a token bucket the read-compute-write must also be atomic, so it's written as a small **Lua script** that Redis runs as one indivisible step. Without that, two servers could both see "1 token left" and both allow.

Practical concerns:

- **Latency**: one Redis round trip per request (~0.5 ms in the same data center). Acceptable for most APIs.
- **Redis down?** Decide: **fail open** (allow traffic, risk overload) or **fail closed** (reject, risk an outage). Most public APIs fail open for user-facing limits.
- **Hot keys**: a single huge client hammers one Redis key. Shard by key (Day 33), or let each server take a local slice of the budget and sync periodically, trading accuracy for speed.
- **Clock skew**: windows keyed by server clock can disagree slightly between servers (Day 41). Using Redis's own time inside the script avoids that.

## The math

```text
Token bucket: capacity 10, refill 2/s, client idle for a while, then sends nonstop.
Max requests allowed in the first 60 s = 10 (burst) + 2 × 60 (refill) = 130
Long-run average                       = 2 requests/s = 120/min

Fixed window, limit 100/min:
Worst case in any 2-second span around a boundary = 100 + 100 = 200

Redis memory for 10 million active users with a token bucket:
  ~2 numbers + key ≈ ~100 bytes per user in practice
  10,000,000 × 100 B = 1 GB  → fits in one Redis instance's RAM
```

## In an interview

"Design a rate limiter" is a classic question in its own right, and rate limits also show up inside other designs (login, SMS, a public API). Interviewers listen for:

- Clarifying questions: per user or per IP? Hard or soft limit? Single server or distributed?
- Naming an algorithm and its trade-off, especially token bucket's burst + average knobs.
- A shared store with **atomic** updates, and what happens if that store fails.
- The client experience: `429`, `Retry-After`, remaining-quota headers.

Good answer in a paragraph: "I'd put the limiter in the API gateway, keyed by API key, using a token bucket with capacity 20 and refill 10/s, stored in a Redis cluster. Each check is one Lua script that refills and takes a token atomically, so concurrent servers can't over-allow. Rejected requests get 429 with Retry-After. If Redis is unreachable we fail open but keep a coarse per-server in-memory limit as a safety net."

## Common mistakes

- **Counting in each server's memory** behind a load balancer: the real limit becomes `limit × servers`.
- **Read then write without atomicity**: two servers both see room and both allow.
- **Limiting only by IP**: punishes shared networks and is trivially dodged by attackers with many IPs.
- **Forgetting the boundary burst** of fixed windows.
- **Clients retrying instantly on 429**: they should honor `Retry-After` and back off (Day 43).

## Before moving on

- [ ] I can implement a token bucket from memory and explain its two parameters
- [ ] I can explain the fixed window boundary problem and how sliding windows fix it
- [ ] I can compute a sliding window counter estimate
- [ ] I can explain why a distributed limiter needs a shared store and atomic updates
- [ ] I can argue fail-open vs fail-closed for a given use case

## Go deeper (optional)

- [Wikipedia: Token bucket](https://en.wikipedia.org/wiki/Token_bucket)
- [Wikipedia: Leaky bucket](https://en.wikipedia.org/wiki/Leaky_bucket)
- [MDN: 429 Too Many Requests](https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/429)
- [Redis documentation: INCR (includes a rate limiter pattern)](https://redis.io/docs/latest/commands/incr/)
