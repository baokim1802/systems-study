# Distributed Transactions and Sagas

> Inside one database, a transaction makes several changes all-or-nothing (Day 22). Once an order touches a payments service, an inventory service and a shipping service, each with its own database, that guarantee disappears. This lesson is about getting it back, or living well without it.

## The big idea

You're booking a trip: a flight, a hotel, and a rental car, from three different companies. You don't want the flight without the hotel. Two ways to handle it:

1. **The cautious way:** ask all three to *hold* your booking ("can you reserve this for me?"). Only when all three say yes do you say "confirm everything". If any says no, you say "release everything". That's **two-phase commit**.
2. **The optimistic way:** book the flight for real. Then the hotel. If the car fails, **cancel** the hotel and **cancel** the flight (maybe paying a fee). That's a **saga**: a sequence of steps, each with an "undo" called a **compensation**.

The first gives you true all-or-nothing but everyone waits on everyone. The second keeps everyone independent but the world sees in-between states (for a moment, you have a flight and no hotel).

## Why the problem exists

In a **microservice** architecture, each service owns its own database. That's the point: teams can change their schema and deploy independently. But a single business action now spans several databases:

```text
PlaceOrder
 ├─ orders DB:     INSERT order (status = NEW)
 ├─ payments DB:   charge $49.99
 └─ inventory DB:  stock = stock - 1
```

There's no `BEGIN ... COMMIT` that covers three separate databases. If the payment succeeds and the inventory update fails, you've charged a customer for something you can't ship.

## Two-phase commit (2PC)

**2PC** adds a **coordinator** (often a component of the service starting the transaction) and treats each database as a **participant**.

```text
Coordinator                    Participant A      Participant B
    │──── PREPARE ────────────────▶│                  │
    │──── PREPARE ───────────────────────────────────▶│
    │                    write changes + "prepared"   │
    │                    to log, keep locks           │
    │◀──────────── YES ────────────│                  │
    │◀──────────── YES ───────────────────────────────│
    │ write "COMMIT" to own log  (the point of no return)
    │──── COMMIT ─────────────────▶│                  │
    │──── COMMIT ────────────────────────────────────▶│
    │◀──────────── ACK ────────────│                  │
    │◀──────────── ACK ───────────────────────────────│
```

**Phase 1 (prepare / vote):** each participant does all the work, writes it durably, and promises: *"If you tell me to commit, I definitely can."* Voting YES is a promise it can't take back. Any NO (or a timeout) means the coordinator decides ABORT.

**Phase 2 (commit / abort):** the coordinator writes its decision to its own log, then tells everyone. Participants that voted YES must obey, retrying forever if needed.

### The weak spot: a blocking protocol

What if the coordinator crashes **after** participants voted YES but **before** they hear the decision?

- A participant can't commit on its own: maybe another participant voted NO.
- It can't abort on its own: maybe the coordinator already told someone else to commit.
- So it is **in doubt** and must wait, still **holding locks** on the rows involved, until the coordinator recovers.

Those locked rows block other transactions. One crashed coordinator can freeze part of your system. That's why 2PC is called a **blocking** protocol. (Three-phase commit tries to fix this but assumes bounded network delays, which real networks don't give you — Day 38.)

Other costs:

- At least **2 round trips** plus several disk `fsync`s per transaction.
- Every participant must be up: the transaction's availability is the *product* of the participants' availability (Day 45).
- Locks are held across network calls, so throughput drops under contention.

Where 2PC is fine: *inside* one database system that controls all participants. Distributed databases like Google Spanner and CockroachDB use 2PC between shards, and make each participant a replicated Raft/Paxos group (Day 42), so a "crashed" participant or coordinator is really a group that fails over quickly. The **XA** standard does 2PC across different databases and message brokers, but it's rarely used across microservices.

## Sagas

A **saga** (Garcia-Molina and Salem, 1987) splits the big transaction into a sequence of **local transactions** `T1, T2, …, Tn`. Each one commits immediately in its own service. For each step there's a **compensating transaction** `C1, C2, …` that semantically undoes it.

```text
Happy path:   T1 → T2 → T3 → T4   done

T3 fails:     T1 → T2 → T3 ✗
                        then C2 → C1   (in reverse order)
```

For an online order:

| Step | Local transaction | Compensation |
|---|---|---|
| 1 | Orders: create order `PENDING` | Mark order `CANCELLED` |
| 2 | Inventory: reserve 1 item | Release reservation |
| 3 | Payments: charge card | Refund card |
| 4 | Orders: mark `CONFIRMED` (no compensation needed) | — |

Important properties:

- **Compensation is a semantic undo, not a time machine.** You can't "un-send" an email; you send a correction. You don't delete a charge; you issue a refund, and the customer may see both on their statement.
- **Compensations must not fail permanently.** They're retried until they succeed, so they must be **idempotent** (Day 43).
- **Order steps wisely.** Put steps that are easy to undo (reservations) first and hard-to-undo steps (charging money, shipping) last. The step after which the saga is committed to finishing is called the **pivot**.
- **No isolation.** Other requests can see the in-between state, such as a reserved item that will be released a second later. Teams handle this with **semantic locks**: the `PENDING` status tells other code "don't treat this as final yet".

### Choreography vs orchestration

| | Choreography | Orchestration |
|---|---|---|
| How | Each service listens for events and reacts ("OrderCreated" → inventory reserves → emits "ItemReserved" → payments charges…) | A central **orchestrator** tells each service what to do next and tracks the state |
| Pros | No central component, very loose coupling | The whole flow is in one place: easy to read, test, monitor, add timeouts |
| Cons | The flow is spread across services; hard to see, easy to create cycles | Orchestrator is extra infrastructure; risk of it becoming a "god service" |
| Good for | Short sagas (2–3 steps) | Longer or business-critical flows |

Workflow engines like Temporal or AWS Step Functions are popular ways to build orchestrators: they persist the saga's state so it can resume after a crash.

## The dual-write problem and the outbox pattern

Sagas depend on services publishing events reliably. Here is a classic bug:

```js
async function placeOrder(order) {
  await db.query('INSERT INTO orders ...', [order.id, order.total]); // 1
  await kafka.send('order-created', { id: order.id });              // 2
}
```

If the process crashes between line 1 and line 2, the order exists but no event is ever sent: inventory never reserves, the saga stalls. Swap the order and you can publish an event for an order that never got saved. Writing to **two systems** without a shared transaction is the **dual-write problem**.

The **transactional outbox** fixes it by writing to only one system:

```js
async function placeOrder(order) {
  await db.transaction(async (tx) => {
    await tx.query('INSERT INTO orders (id, total) VALUES ($1, $2)', [order.id, order.total]);
    await tx.query(
      'INSERT INTO outbox (id, topic, payload) VALUES ($1, $2, $3)',
      [crypto.randomUUID(), 'order-created', JSON.stringify({ id: order.id })]
    );
  }); // both rows commit together, or neither does
}
```

A separate **relay** process reads new outbox rows and publishes them, then marks them sent. It can poll the table, or use **change data capture** (CDC), reading the database's write-ahead log (Day 22) with a tool like Debezium.

The relay can crash after publishing but before marking the row sent, so it may publish **twice**: the outbox gives **at-least-once** delivery. Consumers must dedupe by the event `id` (sometimes called the **inbox** pattern). Day 43 again: at-least-once + idempotency.

## The math

**Availability of 2PC.** Every participant must be up for the transaction to commit. With 4 participants each available 99.9% of the time:

```text
0.999^4 = 0.996006  →  99.6% (about 4× the failure rate of one service)
```

**Messages.** For `n` participants, 2PC sends prepare, vote, commit, ack: `4n` messages, in 2 sequential round trips. With 4 participants and 2 ms per round trip, plus an fsync of ~1 ms at each of the 3 log-write points (prepare, decision, commit):

```text
messages = 4 × 4 = 16
latency ≈ 2 round trips × 2 ms + ~3 ms of fsyncs ≈ 7 ms, with locks held the whole time
```

A saga's steps don't hold locks across services, so each service's throughput is limited only by its own local transaction.

## In an interview

Any design with "order + payment + inventory" invites the question *"what if the payment succeeds but the inventory fails?"* Interviewers want you to know 2PC exists and why it's avoided across services, to sketch a saga with concrete compensations, and to spot the dual-write problem.

A strong answer: *"Each service owns its data, so there's no single transaction. I'd use an orchestrated saga: create the order as PENDING, reserve stock, charge the card last since it's hardest to undo, then confirm. Each step has an idempotent compensation (release reservation, refund), and the PENDING status acts as a semantic lock. Each service publishes its events with a transactional outbox, so a DB write and its event can't diverge; consumers dedupe by event ID. I'd avoid 2PC across services because a coordinator crash leaves participants blocked holding locks, and availability becomes the product of every participant's."*

## Common mistakes

- **"Just call the services one after another and hope."** Without compensations, a mid-way failure leaves inconsistent data forever.
- **Thinking a compensation restores the exact old state.** It's a new business action (refund, cancellation) and others may have seen the intermediate state.
- **Publishing events directly after a DB commit.** That's a dual write. Use an outbox.
- **Assuming the outbox gives exactly-once.** It gives at-least-once; dedupe downstream.
- **"2PC is always bad."** It's fine within a single distributed database with replicated participants; it's the cross-service, cross-team use that hurts.

## Before moving on

- [ ] I can draw 2PC's two phases and explain what a YES vote promises
- [ ] I can explain why a coordinator crash blocks participants
- [ ] I can design a saga with compensations and justify the step order
- [ ] I can compare choreography and orchestration
- [ ] I can explain the dual-write problem and the outbox pattern

## Go deeper (optional)

- [Wikipedia: Two-phase commit protocol](https://en.wikipedia.org/wiki/Two-phase_commit_protocol)
- [Sagas (Garcia-Molina and Salem, 1987)](https://www.cs.cornell.edu/andru/cs711/2002fa/reading/sagas.pdf)
- [microservices.io: Saga pattern](https://microservices.io/patterns/data/saga.html) and [Transactional outbox](https://microservices.io/patterns/data/transactional-outbox.html)
- *Designing Data-Intensive Applications*, chapter 9 (distributed transactions) and chapter 11 (change data capture)
