# Retries, Idempotency, and Exactly-Once

> On a network, "no reply" doesn't mean "it didn't happen". Knowing how to retry safely, without hammering a struggling server or charging a customer twice, is one of the most practical skills in backend engineering and a favorite interview topic.

## The big idea

You order a pizza by phone. The line goes dead right after you say your address. Did they get the order? You don't know. If you call again and order again, you might get **two pizzas**. If you don't call, you might get **none**.

The smart move: call back and say *"Hi, I'm order #4512 — did that go through?"* Now calling twice is harmless, because the shop recognizes the same order number. That number is an **idempotency key**, and the habit of "retry, but in a way that's safe to repeat" is what this whole lesson is about.

Remember Day 38: when a request times out, there are three possibilities and the client can't tell them apart:

```text
1. Request lost on the way      → server never saw it
2. Server crashed mid-work      → maybe half done
3. Reply lost on the way back   → server DID it, you just didn't hear
```

## Timeouts first

A **timeout** is how long you're willing to wait before giving up. Without one, a single stuck dependency can tie up all your threads or connections forever.

- **Connect timeout:** how long to wait to open a TCP connection (Day 12). Usually short, e.g. 1 s.
- **Request (read) timeout:** how long to wait for the response. Base it on the dependency's measured latency, e.g. a bit above its p99 (Day 46): if p99 is 200 ms, a 500 ms–1 s timeout is reasonable. A 30 s default is almost always too long.
- **Overall deadline:** the total time budget for the user's request. If the caller has 2 s total and 1.8 s are gone, don't start a retry that needs 1 s. gRPC passes deadlines down the call chain for exactly this reason.

## Which failures should you retry?

| Retry | Don't retry |
|---|---|
| Timeouts, connection reset / refused | `400 Bad Request` — it'll be just as bad next time |
| `503 Service Unavailable`, `502`, `504` | `401` / `403` — retrying won't grant permission |
| `429 Too Many Requests` (honor the `Retry-After` header) | `404 Not Found`, `409 Conflict`, `422` |
| `500` *sometimes*, if the operation is idempotent | Anything non-idempotent **without** an idempotency key |

Rule of thumb: retry **transient** errors (the system might be fine in a moment), never **permanent** ones (the request itself is wrong).

## Exponential backoff with jitter

If a server is overloaded and every client retries instantly, you add load exactly when it hurts most — a **retry storm**. Two fixes work together:

1. **Exponential backoff:** wait longer after each failure: 100 ms, 200 ms, 400 ms, 800 ms… capped at some maximum.
2. **Jitter:** add randomness to each wait. Without it, 10,000 clients that failed at the same moment all retry at the same moment, again and again, in synchronized waves (the "thundering herd" from Day 29).

The AWS Architecture Blog's well-known analysis found **full jitter** works very well: wait a random amount between 0 and the exponential value.

```text
attempt n:  ceiling = min(cap, base × 2^n)
            sleep   = random(0, ceiling)

base = 100 ms, cap = 2000 ms
n=0 → up to 100 ms
n=1 → up to 200 ms
n=2 → up to 400 ms
n=3 → up to 800 ms
n=4 → up to 1600 ms
n=5 → up to 2000 ms (capped)
```

Here it is in JavaScript (runs in Node 18+ or a browser):

```js
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, { attempts = 5, base = 100, cap = 2000, isRetryable } = {}) {
  for (let n = 0; ; n++) {
    try {
      return await fn();
    } catch (err) {
      const last = n === attempts - 1;
      if (last || !isRetryable(err)) throw err;
      const ceiling = Math.min(cap, base * 2 ** n);
      await sleep(Math.random() * ceiling); // full jitter
    }
  }
}

// Usage
let calls = 0;
const flaky = async () => {
  calls++;
  if (calls < 3) throw Object.assign(new Error('busy'), { status: 503 });
  return 'ok';
};
withRetry(flaky, { isRetryable: (e) => [429, 502, 503, 504].includes(e.status) })
  .then((v) => console.log(v, 'after', calls, 'calls')); // ok after 3 calls
```

### Don't multiply retries

Suppose a request goes `browser → API → orders service → database`, and **each layer** makes up to 3 attempts. If the database is down, one click becomes `3 × 3 × 3 = 27` database attempts. With 4 layers, 81. Retries at every layer turn a small outage into a big one.

Fixes:

- Retry at **one** layer (usually the one closest to the user, or the one that knows the operation is safe).
- **Retry budgets:** e.g. retries may be at most 10% of total requests; beyond that, fail fast.
- **Circuit breakers:** after many failures, stop calling the dependency for a while and fail immediately, then let a few test requests through to see if it recovered.

## Idempotency

An operation is **idempotent** if doing it twice has the same effect as doing it once.

- `x = 5` is idempotent. `x = x + 1` is not.
- "Set order 42's status to SHIPPED" is idempotent. "Add $10 to the balance" is not.

HTTP defines `GET`, `HEAD`, `PUT`, `DELETE` and `OPTIONS` as idempotent (Day 14). `POST` is not, and `PATCH` isn't guaranteed to be. That's why browsers warn you before resubmitting a form.

### Idempotency keys

To make a non-idempotent operation safe to retry, the **client** generates a unique ID for the *intent* (one checkout, one transfer) and sends it with every attempt. Stripe popularized this with an `Idempotency-Key` header.

```text
POST /payments
Idempotency-Key: 7f3c9a2e-1b4d-4c8e-9f00-2a6b5d1e8c47
{ "amount": 4999, "currency": "usd", "card": "tok_..." }
```

On the server:

```text
1. INSERT key into idempotency table (unique constraint), status = IN_PROGRESS
   - if the key already exists:
       status DONE        → return the saved response, do nothing else
       status IN_PROGRESS → return 409 "still processing, retry later"
       same key, different request body → return an error (client bug)
2. Do the work (charge the card)
3. Save the response with the key, status = DONE
4. Return the response
```

Key details interviewers like:

- The key is generated **once per user intent**, before the first attempt, not per attempt.
- The **unique constraint** in the database is what makes concurrent duplicates safe; checking "does it exist?" then inserting is a race (Day 7).
- Keys are kept for a while (Stripe keeps them at least 24 hours) and then expire.
- Ideally store the key in the **same transaction** as the business change, so "did the work" and "remembered the key" can't disagree.

Natural keys work too: "one payout per `(user_id, month)`" enforced by a unique index is an idempotency key you didn't have to invent.

## Delivery guarantees

Messaging systems (Day 34) describe what they promise with three phrases:

| Guarantee | How | Risk |
|---|---|---|
| **At-most-once** | Send, never retry (or ack before processing) | Messages can be **lost** |
| **At-least-once** | Retry until acknowledged (ack after processing) | Messages can be **duplicated** |
| **Exactly-once** | ? | ? |

Over an unreliable network, exactly-once **delivery** is impossible: the sender can never be sure the last ack wasn't lost (this is the classic *Two Generals' Problem*). What real systems offer is **exactly-once processing** or "effectively once":

```text
exactly-once effect = at-least-once delivery + idempotent (deduplicating) processing
```

Kafka's "exactly-once semantics" is real but scoped: an idempotent producer plus transactions make *read from Kafka → process → write to Kafka* happen once. The moment your consumer does something **outside** Kafka (sends an email, calls a payment API), you're back to at-least-once and need your own idempotency, for example a table of processed message IDs.

```js
// Effectively-once consumer: remember what we've handled
const processed = new Set(); // in real life: a DB table with a unique key

async function handle(msg) {
  if (processed.has(msg.id)) return;      // duplicate delivery → ignore
  await sendWelcomeEmail(msg.userId);
  processed.add(msg.id);                  // crash between these two lines
}                                         // → email may still go twice!
```

That last comment is the honest truth: even dedup has a tiny window unless the side effect itself accepts an idempotency key (many email and payment providers do).

## The math

**Do retries help?** If each attempt independently fails with probability `p = 0.05`:

```text
1 attempt:  fail 5%
3 attempts: fail 0.05³ = 0.000125 = 0.0125%
```

But this assumes independent failures. If the server is down for a minute, all three attempts within 1.5 s fail together. Retries fix **blips**, not **outages**.

**How long might the user wait?** With timeout 500 ms and backoff ceilings 100, 200, 400 ms (no jitter, worst case) over 4 attempts:

```text
4 × 500 ms (timeouts) + 100 + 200 + 400 (sleeps) = 2,700 ms
```

If your page must load in 1 s, that retry policy is wrong for it.

## In an interview

This shows up in payments, ordering, notifications, and any queue-based design. Listen for the moment you say "and we retry" — the interviewer will ask *"what if it actually succeeded the first time?"*

A strong answer: *"Every call has a timeout based on the dependency's p99. We retry only transient errors, with exponential backoff and full jitter, and only at one layer, with a retry budget so we don't amplify an outage. Because a timeout doesn't tell us whether the server acted, writes carry a client-generated idempotency key stored under a unique constraint; a duplicate returns the saved response. Our queue gives at-least-once delivery, so consumers dedupe by message ID — that's how we get exactly-once effects, since exactly-once delivery isn't possible."*

## Common mistakes

- **Retrying immediately in a tight loop.** Always back off, always add jitter.
- **Retrying non-idempotent POSTs blindly.** That's how people get double-charged.
- **New idempotency key per attempt.** Then it dedupes nothing. One key per intent.
- **"Check then insert" for dedup.** Two concurrent requests both pass the check. Use a unique constraint.
- **Believing a tool's "exactly-once" covers your side effects.** It covers its own boundary only.
- **No timeout at all.** The default in many HTTP clients is "wait forever" or very long.

## Before moving on

- [ ] I can list the three things a timeout might mean
- [ ] I can write retry-with-backoff-and-jitter from memory
- [ ] I can explain why retries at every layer multiply
- [ ] I can design an idempotency-key flow, including concurrent duplicates
- [ ] I can explain why exactly-once delivery is impossible and what "effectively once" means

## Go deeper (optional)

- [AWS Architecture Blog: Exponential Backoff and Jitter](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/)
- [Stripe API docs: Idempotent requests](https://docs.stripe.com/api/idempotent_requests)
- [Wikipedia: Two Generals' Problem](https://en.wikipedia.org/wiki/Two_Generals%27_Problem)
- *Google SRE Book*, chapter "Handling Overload" and "Addressing Cascading Failures"
