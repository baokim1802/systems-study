# Time and Clocks

> "Which happened first?" sounds trivial until your events come from different machines whose clocks disagree. Today: why wall clocks lie, which clock to use for what, and the clever logical clocks that order events without trusting time at all.

## The big idea

Two friends are texting about who arrived at the café first. Anna's phone says she arrived at 3:02. Ben's says 3:01. Did Ben arrive first? Not necessarily: Ben's phone might be two minutes fast. **Timestamps from different clocks can't be compared reliably.**

But some things you *can* be sure of. If Ben texted "I'm here, where are you?" and Anna replied "Just walked in!", then Ben's message definitely came before Anna's reply, whatever the clocks say. Anna read his message before writing hers. That **cause → effect** relationship is something we can track exactly, with no clocks at all. That's the idea behind **logical clocks**.

## Why wall clocks lie

Every computer has a **quartz crystal** oscillator that ticks a counter. It's cheap and decent, but it **drifts**: it runs slightly fast or slow depending on the crystal and the temperature. Google's design (as described in *Designing Data-Intensive Applications*) assumes up to **200 ppm** (parts per million) of drift:

```text
drift = 200 ppm = 200 / 1,000,000 = 0.0002 seconds per second

resynced every 30 s:   30 × 0.0002     = 0.006 s  = 6 ms of possible error
resynced once a day:   86,400 × 0.0002 ≈ 17 s     of possible error
```

So clocks need regular correcting, which brings its own problems.

### NTP

**NTP (Network Time Protocol)** lets a machine ask a time server what time it is and adjust. It estimates the network delay from the round trip and assumes the trip was symmetric. Over the internet that gives accuracy of roughly **tens of milliseconds**, better within a data center, and much worse if the network is congested or the path is lopsided.

Things that go wrong in practice:

- **Clocks jump.** If a clock is far off, NTP may step it, **backwards** included. Code that computes `end - start` with wall-clock times can get a **negative duration**.
- **Leap seconds.** Occasionally a minute has 61 seconds (`23:59:60`). In 2012 a leap second triggered bugs that took down parts of Reddit and other sites. Many companies now "smear" the extra second over a day instead. (The world's timekeepers have agreed to stop adding leap seconds by 2035.)
- **Misconfigured or blocked NTP**: a VM's clock can quietly drift by minutes.
- **VM pauses**: a virtual machine can be paused for seconds, then resumes with a clock that suddenly leaps forward.

## Two kinds of clocks on every machine

| | Wall clock (time-of-day) | Monotonic clock |
|---|---|---|
| What it says | "it's 2026-09-30 14:03:07 UTC" | "N nanoseconds since some arbitrary start" |
| JavaScript | `Date.now()` | `performance.now()`, Node's `process.hrtime.bigint()` |
| Can jump backwards? | yes (NTP steps, manual changes) | **no**, only goes forward |
| Comparable across machines? | roughly (± NTP error) | **no**, meaningless on another machine |
| Use for | showing times to humans, log timestamps, expiry dates | measuring durations, timeouts, rate limiters |

```js
// Wrong: measuring a duration with the wall clock
const t0 = Date.now();
doWork();
console.log(Date.now() - t0);          // can be negative if NTP stepped the clock

// Right: monotonic clock for durations
const s = performance.now();
doWork();
console.log(performance.now() - s);    // always ≥ 0

function doWork() { for (let i = 0; i < 1e6; i++); }
```

The token bucket from Day 35 and the timeouts from Day 38 should use a monotonic clock.

## The danger: "last write wins" with wall clocks

Many replicated databases resolve conflicts with **last write wins (LWW)**: keep the write with the latest timestamp, discard the other. If the timestamps come from different machines' wall clocks:

```text
Node 1 clock is 100 ms fast. Node 2 clock is correct.

real time 12:00:00.000  client X writes  color=red   via Node 1 → stamped 12:00:00.100
real time 12:00:00.050  client Y writes  color=blue  via Node 2 → stamped 12:00:00.050

LWW keeps red (larger timestamp). But blue was really written later.
Y's write silently vanishes. No error, no log, just lost data.
```

That's why ordering by physical time across machines is risky. We need something better.

## Lamport clocks

In 1978 Leslie Lamport defined **happened-before** (written `→`): event `a → b` if

1. `a` and `b` are on the same machine and `a` came first, or
2. `a` is sending a message and `b` is receiving that message, or
3. there's a chain: `a → c` and `c → b`.

If neither `a → b` nor `b → a`, the events are **concurrent**: neither could have influenced the other.

A **Lamport clock** is just a counter on each node, with two rules:

- Before each local event or send: `counter += 1`, and attach the counter to outgoing messages.
- On receive: `counter = max(counter, received) + 1`.

```js
class LamportClock {
  constructor() { this.time = 0; }
  tick() { return ++this.time; }              // local event or send
  receive(remote) {                           // message arrived carrying `remote`
    this.time = Math.max(this.time, remote) + 1;
    return this.time;
  }
}

const a = new LamportClock(), b = new LamportClock();
a.tick();                   // A does something → A = 1
const msg = a.tick();       // A sends          → A = 2, message carries 2
b.tick();                   // B does something → B = 1
b.receive(msg);             // B receives       → B = max(1, 2) + 1 = 3
console.log(a.time, b.time);  // 2 3
```

Guarantee: **if `a → b`, then `L(a) < L(b)`**. Ties are broken by node id, giving a **total order** all nodes agree on, consistent with causality. That's enough for things like ordering operations in a replicated log.

The limit: the reverse isn't true. `L(a) < L(b)` does **not** mean `a` caused `b`; they might be concurrent. Lamport clocks can't detect concurrency.

## Vector clocks

A **vector clock** keeps one counter **per node**: `{A: 2, B: 1, C: 0}` means "I've seen 2 events from A, 1 from B, 0 from C". Rules:

- Local event at node X: increment your own entry `X`.
- Send: attach your whole vector.
- Receive: take the element-wise **max** of yours and the received one, then increment your own entry.

Compare two vectors `V` and `W`:

- `V` **before** `W` if every entry of `V` ≤ the matching entry of `W` (and they're not equal).
- **Concurrent** if `V` is bigger in some entry and `W` is bigger in another.

```js
const increment = (vc, node) => ({ ...vc, [node]: (vc[node] || 0) + 1 });

function merge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = Math.max(out[k] || 0, v);
  return out;
}

function compare(a, b) {
  let aBigger = false, bBigger = false;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if ((a[k] || 0) > (b[k] || 0)) aBigger = true;
    if ((b[k] || 0) > (a[k] || 0)) bBigger = true;
  }
  if (aBigger && bBigger) return "concurrent";
  if (aBigger) return "after";
  if (bBigger) return "before";
  return "equal";
}

const v0 = increment({}, "A");                // A writes the doc      {A:1}
const vB = increment(merge({}, v0), "B");     // B edits after seeing  {A:1, B:1}
const vC = increment(merge({}, v0), "C");     // C edits after seeing  {A:1, C:1}
console.log(compare(v0, vB));                 // "before"
console.log(compare(vB, vC));                 // "concurrent" → a real conflict
const vM = increment(merge(vB, vC), "A");     // A merges both         {A:2, B:1, C:1}
console.log(compare(vM, vB));                 // "after"
```

This is how Amazon's Dynamo detected conflicting shopping-cart versions: if two versions are concurrent, keep **both** ("siblings") and let the application merge them, instead of silently dropping one like LWW. The cost: the vector grows with the number of nodes (or clients) writing, so systems prune or bound it. You'll use this in the key-value store design on Day 66.

| | Lamport clock | Vector clock |
|---|---|---|
| Size | one number | one number per node |
| If `a → b` | `L(a) < L(b)` ✓ | `V(a) < V(b)` ✓ |
| Detects concurrency? | no | **yes** |
| Typical use | total ordering, log sequence | conflict detection in replicas |

## TrueTime: making physical time trustworthy

Google's **Spanner** database took another path: make wall-clock **uncertainty** explicit. Each data center has GPS receivers and atomic clocks. The **TrueTime** API doesn't return "now"; it returns an **interval** `[earliest, latest]` guaranteed to contain the real time. The uncertainty `ε` is typically a few milliseconds (the Spanner paper reports roughly 1–7 ms).

To commit a transaction at timestamp `t`, Spanner performs a **commit wait**: it waits until `TT.now().earliest > t`, so every machine anywhere agrees that `t` is in the past. Waiting out a few milliseconds of uncertainty buys **globally ordered, linearizable** transactions using physical time. The lesson: **if you know how wrong your clock might be, you can wait out the error.** Without GPS and atomic clocks, many databases (CockroachDB, YugabyteDB) use **hybrid logical clocks**, which combine a physical timestamp with a Lamport-style counter.

## In an interview

Clocks show up when you discuss conflict resolution ("last write wins?"), ordering messages in a chat (Day 58), distributed IDs like Snowflake (Day 56), or the key-value store capstone. Interviewers listen for:

- Wall clocks across machines aren't reliable for ordering; monotonic clocks for durations.
- LWW with physical timestamps can silently lose writes.
- Lamport clocks give a causal-consistent total order; vector clocks detect concurrent writes.
- TrueTime as the "pay with waiting" approach.

Good paragraph: "I wouldn't order chat messages by server wall-clock time, since clocks drift and NTP can step them. Within a conversation I'd have one partition assign a monotonically increasing sequence number. For the replicated store, I'd attach vector clocks to values so concurrent writes are detected and kept as siblings for the app to merge, instead of last-write-wins silently dropping one."

## Common mistakes

- **Measuring durations with `Date.now()`**. Use a monotonic clock.
- **Trusting timestamps from different machines to order events**.
- **Thinking Lamport clocks detect concurrency**. Only vector clocks (or similar) do.
- **Assuming NTP gives perfect sync**. Expect milliseconds of error, occasionally much more.
- **Forgetting leap seconds and VM pauses** when code assumes time moves smoothly.

## Before moving on

- [ ] I can compute clock drift error from ppm and resync interval
- [ ] I can say when to use wall clock vs monotonic clock in JavaScript
- [ ] I can implement a Lamport clock and explain its guarantee and its limit
- [ ] I can implement vector clock compare and spot concurrent versions
- [ ] I can explain TrueTime's commit wait in two sentences

## Go deeper (optional)

- Leslie Lamport, "Time, Clocks, and the Ordering of Events in a Distributed System", *Communications of the ACM*, 1978
- *Designing Data-Intensive Applications*, Chapter 8 "Unreliable Clocks"
- [Wikipedia: Lamport timestamp](https://en.wikipedia.org/wiki/Lamport_timestamp)
- [Wikipedia: Vector clock](https://en.wikipedia.org/wiki/Vector_clock)
- [Wikipedia: Network Time Protocol](https://en.wikipedia.org/wiki/Network_Time_Protocol)
- Corbett et al., "Spanner: Google's Globally-Distributed Database", OSDI 2012
