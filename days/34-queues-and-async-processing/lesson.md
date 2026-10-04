# Queues and Async Processing

> Most slow work doesn't need to happen while the user waits. Queues let one part of a system say "please do this later" and get back to work, which makes systems faster, calmer under spikes, and much harder to knock over.

## The big idea

Think of a busy restaurant. The waiter doesn't stand in the kitchen until your pasta is cooked. They write your order on a ticket, clip it to the rail, and go serve the next table. Cooks pull tickets off the rail at their own pace. If twenty tables order at once, the rail just gets longer for a while; nobody is turned away and the waiter stays fast.

That rail is a **message queue**:

- The waiter is a **producer** (code that creates work).
- The ticket is a **message** (a small piece of data describing the work, usually JSON).
- The cooks are **consumers** or **workers** (code that does the work).
- The rail is the **broker** (a server whose only job is to hold messages safely until someone takes them).

The key word is **decoupling**. The producer doesn't need to know who the consumers are, how many there are, or whether they're even running right now.

## Sync vs async: why bother?

Imagine a sign-up endpoint that, before replying, saves the user (10 ms), sends a welcome email through an email provider (400 ms), resizes the profile picture (800 ms) and updates analytics (50 ms).

```text
Synchronous:  10 + 400 + 800 + 50 = 1,260 ms before the user sees "Welcome!"

With a queue: save user (10 ms) + publish 3 messages (~3 ms) = ~13 ms
              email, resize and analytics happen in the background
```

That's almost 100x faster from the user's point of view. And if the email provider is down for five minutes, sign-up still works: the email messages just wait in the queue until it comes back.

What you give up: the work is no longer done when you reply. If the user's very next screen shows their resized avatar, you need a placeholder. That's the trade-off of every async design, called **eventual completion**.

## How it actually works

```text
 producers                 broker                     consumers
 ┌────────┐  publish   ┌──────────────────┐  receive  ┌──────────┐
 │ web    │ ─────────▶ │ [m5][m4][m3][m2] │ ────────▶ │ worker A │
 │ server │            │   queue "emails" │           └──────────┘
 └────────┘            └──────────────────┘ ────────▶ ┌──────────┐
                                                      │ worker B │
                                                      └──────────┘
```

A typical message lifecycle in a classic queue (RabbitMQ, Amazon SQS):

1. The producer **publishes** a message. The broker writes it to disk (often to several machines) and replies "got it".
2. A consumer **receives** it. The message becomes invisible to other consumers but is *not* deleted yet. In SQS this is the **visibility timeout** (30 seconds by default).
3. The consumer does the work, then sends an **ack** (acknowledgement): "done, you can delete it".
4. If the consumer crashes and never acks, the timeout expires and the message reappears for another worker.

Step 4 is what makes queues reliable, and it has a famous consequence: a message can be delivered **more than once** (the worker might crash *after* doing the work but *before* acking). This is called **at-least-once delivery**, and it means consumers should be **idempotent**: doing the same message twice must have the same effect as doing it once. Day 43 covers this in depth.

| Delivery guarantee | What it means | Cost |
|---|---|---|
| At-most-once | Ack before working. Never duplicated, may be lost | Simple, lossy |
| At-least-once | Ack after working. Never lost, may be duplicated | The usual default |
| Exactly-once | Each message has its effect once | Needs idempotency or transactions end to end |

## Point-to-point vs pub/sub

Two shapes come up constantly:

- **Point-to-point (work queue):** each message goes to **one** consumer. Ten resize jobs, three workers: each job is done once, by whichever worker is free. Adding workers adds throughput.
- **Publish/subscribe (pub/sub):** each message goes to **every** subscriber. A `UserSignedUp` event is delivered to the email service, the analytics service and the fraud service. Each gets its own copy.

```text
point-to-point:   m1 → worker A     m2 → worker B     m3 → worker A
pub/sub:          m1 → email, analytics, fraud   (all three get m1)
```

Pub/sub is how you add a new feature without touching the producer: the new service just subscribes.

## Kafka-style logs: a queue that remembers

Classic queues delete a message once it's acked. **Apache Kafka** (and similar systems such as Amazon Kinesis and Redpanda) take a different approach: the broker keeps an **append-only log** (remember Day 19) and never deletes on read. Messages are removed only by a retention rule, such as "keep 7 days".

```text
topic "orders", partition 0
offset:   0    1    2    3    4    5    6
        [o1] [o2] [o3] [o4] [o5] [o6] [o7]   ← new messages appended here
                        ▲              ▲
        billing group is at 3    email group is at 6
```

- A **topic** is a named stream, like `orders`.
- A topic is split into **partitions** (separate logs) so it can be spread over many machines. A message's **key** (say `userId`) is hashed to pick its partition, so all events for one user land in the same partition, **in order**. Ordering is only guaranteed *within* a partition.
- Each message has an **offset**: its position in the partition.
- Each reader just remembers "I've processed up to offset N". Reading is cheap and **replayable**: found a bug in billing? Fix it, rewind billing's offset to yesterday, and reprocess.

### Consumer groups

A **consumer group** is a team of consumers sharing the work for one purpose. Kafka's rule: **each partition is read by exactly one consumer in a group at a time.**

```text
topic with 4 partitions, group "billing" with 2 consumers:
  consumer 1 ← P0, P1
  consumer 2 ← P2, P3

same topic, group "email" with 4 consumers:
  c1 ← P0   c2 ← P1   c3 ← P2   c4 ← P3

add a 5th consumer to "email": it sits idle (no partition left)
```

So within a group you get point-to-point (each message handled once), and across groups you get pub/sub (every group sees everything). The number of partitions is the **ceiling on parallelism** for a group, which is why people often create more partitions than they need today.

## Backpressure

**Backpressure** is how a system says "slow down, I'm full". Without it, a fast producer buries a slow consumer, memory fills, and something crashes.

A queue absorbs short spikes, but it isn't infinite. If producers send 1,000 messages/s and consumers handle 800/s, the backlog grows by 200 every second, forever. Options:

- **Scale consumers** (autoscale on queue depth, a very common pattern).
- **Bound the queue** and make producers wait or get an error (HTTP `429` or `503`) when it's full.
- **Shed load**: drop low-priority work (analytics) to protect high-priority work (payments).
- **Pull, don't push**: consumers ask for work when they're ready (Kafka consumers poll), so they're never handed more than they can take.

Here is a tiny in-process version of a bounded queue in JavaScript:

```js
class BoundedQueue {
  constructor(limit) { this.items = []; this.limit = limit; }
  push(msg) {
    if (this.items.length >= this.limit) return false; // backpressure signal
    this.items.push(msg);
    return true;
  }
  shift() { return this.items.shift(); }
}

const q = new BoundedQueue(2);
console.log(q.push("a"), q.push("b"), q.push("c")); // true true false
```

Node streams do the same thing: `writable.write()` returns `false` when the buffer is full, and you wait for the `'drain'` event before writing more.

## Dead-letter queues

Some messages will never succeed: malformed JSON, a user that was deleted, a bug. If a worker keeps retrying a **poison message** it wastes capacity forever and, in an ordered partition, blocks everything behind it.

The fix is a **dead-letter queue (DLQ)**: after N failed attempts (say 5, with backoff between them), move the message to a separate queue and carry on. Humans or tooling inspect the DLQ, fix the cause, and **redrive** (re-publish) the messages. An alert on "DLQ is not empty" is one of the most useful alerts you can have.

## The math

**Little's Law** (more on Day 52) links backlog, rate and waiting time: `L = λ × W` (items in the system = arrival rate × time each spends there).

```text
Image-resize queue:
  arrival rate       λ = 300 jobs/s
  one job takes        = 0.5 s on one worker → 2 jobs/s per worker
  workers needed       = 300 / 2 = 150 (run ~200 for headroom at 75% utilization)

A deploy pauses all workers for 4 minutes:
  backlog            = 300 jobs/s × 240 s = 72,000 jobs
  200 workers drain    400 jobs/s, but 300/s keep arriving → net 100/s
  time to catch up   = 72,000 / 100 = 720 s = 12 minutes
```

That last line surprises people: spare capacity, not total capacity, decides how fast you recover.

## In an interview

Queues appear in almost every design: "send notifications", "process uploads", "update the feed", "charge the card later". Interviewers listen for:

- **Why** you're adding a queue (decouple, absorb spikes, retry safely, fan out), not just "add Kafka".
- The **delivery guarantee** and how consumers handle duplicates.
- **Ordering**: what needs order, and what key gives it (per user, per order).
- What happens when consumers fall behind or a message keeps failing.

A good one-paragraph answer: "The upload API stores the file and publishes an `ImageUploaded` event keyed by `imageId`, then returns 202 Accepted. A pool of resize workers in one consumer group processes it at-least-once, so the job is idempotent: it writes thumbnails to a deterministic path, so redoing it is harmless. We autoscale workers on queue lag, retry with backoff, and send messages that fail five times to a DLQ with an alert."

## Common mistakes

- **"The queue guarantees exactly-once."** Assume at-least-once and make consumers idempotent.
- **Expecting global ordering from Kafka.** Order holds only within a partition. Pick the key that groups what must be ordered.
- **More consumers than partitions.** Extras sit idle.
- **Using a queue for a request that needs an answer now.** Checking a password through a queue only adds latency.
- **No DLQ, no lag alert.** Then the first sign of trouble is a customer asking where their email went.

## Before moving on

- [ ] I can explain producer, consumer, broker and ack with the restaurant analogy
- [ ] I can say why at-least-once delivery forces idempotent consumers
- [ ] I can explain partitions, offsets and consumer groups, and why partitions cap parallelism
- [ ] I can describe three ways to apply backpressure
- [ ] I can compute backlog and catch-up time for a stalled queue

## Go deeper (optional)

- *Designing Data-Intensive Applications*, Chapter 11 "Stream Processing" (Martin Kleppmann)
- [Apache Kafka documentation: Introduction](https://kafka.apache.org/documentation/#introduction)
- [Amazon SQS visibility timeout](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html)
- [Wikipedia: Message queue](https://en.wikipedia.org/wiki/Message_queue)
