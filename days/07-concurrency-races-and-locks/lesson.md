# Concurrency, Races and Locks

> As soon as two things can happen "at the same time" and touch the same data, you can get bugs that appear once in a million runs and vanish when you add a `console.log`. Learning to see race conditions is one of the most valuable skills in backend engineering, and it is exactly the same skill at every scale, from two threads to two datacenters.

## The big idea

You and your partner share a bank account with $100. You are both at different ATMs at the same moment, each withdrawing $80. Each ATM does three steps:

1. **Read** the balance: $100.
2. **Check**: is $100 ≥ $80? Yes.
3. **Write** the new balance: $100 − $80 = $20.

If the steps interleave like this, the bank hands out $160 from a $100 account:

```text
ATM A                         ATM B                       balance
read balance → 100                                          100
                              read balance → 100            100
check 100 ≥ 80 ✓                                            100
                              check 100 ≥ 80 ✓              100
write 100 − 80 = 20                                          20
                              write 100 − 80 = 20            20   ← $160 paid out!
```

That is a **race condition**: the result depends on the exact timing of operations that share data. Neither ATM did anything wrong on its own. The bug is in the *gap* between read and write.

## Key terms

- **Concurrency**: several tasks are *in progress* at overlapping times. They may take turns on one core.
- **Parallelism**: several tasks *literally execute at the same instant* on different cores.
- **Shared state**: data more than one task can read and write.
- **Atomic operation**: an operation that happens all-or-nothing; no one can observe it half done or sneak in between its steps.
- **Critical section**: a piece of code that touches shared state and must not be run by two tasks at once.

Rob Pike's summary: *concurrency is about dealing with lots of things at once; parallelism is about doing lots of things at once.* A waiter serving ten tables is concurrent. Ten waiters is parallel.

## Why `count++` is not atomic

`count++` looks like one step but is really three machine instructions: load from memory into a register, add 1, store back (Day 04). Two threads incrementing at once:

```text
Thread 1: load count (5)
Thread 2: load count (5)
Thread 1: add → 6, store 6
Thread 2: add → 6, store 6      ← two increments, count went up by one
```

This specific kind of race (two threads, same memory, at least one writing, no synchronization) is called a **data race**. You can reproduce one in Node with worker threads sharing memory:

```js
// race.js — run with: node race.js
const { Worker, isMainThread, workerData } = require("worker_threads");
if (isMainThread) {
  const shared = new Int32Array(new SharedArrayBuffer(8)); // [counter, ready]
  let done = 0;
  for (let i = 0; i < 2; i++) {
    new Worker(__filename, { workerData: shared }).on("exit", () => {
      if (++done === 2) console.log("expected 2000000, got", shared[0]);
    });
  }
} else {
  const arr = workerData;
  Atomics.add(arr, 1, 1);
  while (Atomics.load(arr, 1) < 2);                   // spin until both workers are ready
  for (let i = 0; i < 1_000_000; i++) arr[0]++;      // racy
  // for (let i = 0; i < 1_000_000; i++) Atomics.add(arr, 0, 1);  // correct
}
```

The racy version usually prints something well below 2,000,000 (runs while writing this lesson gave 1,758,465 and 1,417,219), and a different number each run. The "ready" spin makes both workers start counting at the same moment; without it, one worker often finishes before the other has even started, and the bug hides. `Atomics.add` uses a special CPU instruction that does load-add-store as one indivisible step.

## Locks (mutexes)

The general fix is **mutual exclusion**: only one task may be inside the critical section at a time. A **mutex** (mutual exclusion lock) is like the single key to a bathroom: take the key, use the room, give the key back. Anyone else who wants it waits.

```text
lock(m)
  read balance
  check
  write balance       ← critical section: only one thread at a time
unlock(m)
```

Rules of thumb:

- **Keep critical sections small.** While you hold the lock, everyone else waits. Never do slow I/O while holding a lock if you can avoid it.
- **Always release**, even on errors (`try/finally`).
- **Every access** to the shared data must use the same lock. One unprotected reader or writer breaks it.

Related tools: a **semaphore** is a lock with N keys (e.g. "at most 10 concurrent DB connections"); a **read-write lock** allows many readers or one writer.

There is also a lock-free approach, **compare-and-swap (CAS)**: "set the value to 6 *only if* it is still 5; otherwise tell me it changed and I'll retry." Databases use the same idea as **optimistic concurrency**: `UPDATE accounts SET balance = 20, version = 8 WHERE id = 1 AND version = 7`. If zero rows changed, someone else won; re-read and retry.

## Deadlock

Locks introduce a new failure. Two friends each need both the pen and the notebook. Alice grabs the pen, Bob grabs the notebook. Alice waits for the notebook; Bob waits for the pen. Forever.

```text
Thread 1: lock(A) ...... waiting for B ──┐
                                         │  cycle → nobody ever proceeds
Thread 2: lock(B) ...... waiting for A ──┘
```

A **deadlock** can only happen when all **four Coffman conditions** hold at once:

1. **Mutual exclusion**: a resource can be held by only one task.
2. **Hold and wait**: a task holds one resource while waiting for another.
3. **No preemption**: resources can't be taken away; only the holder releases them.
4. **Circular wait**: there is a cycle of tasks, each waiting for the next.

Break any one and deadlock is impossible. The most practical fix is to break **circular wait** with a **global lock order**: always lock accounts in order of ID, for example. Other fixes: acquire all locks at once, or use timeouts (`tryLock` with a deadline) and retry. Databases detect deadlock cycles automatically and abort one transaction (Day 22).

Two cousins: **livelock** (tasks keep reacting to each other and never progress, like two people stepping aside in a hallway in sync) and **starvation** (one task never gets the lock because others always win).

## JavaScript: one thread, still racy

JavaScript runs your code on **one thread** with an event loop (Day 09). A function runs to completion without being interrupted by other JS. So `count++` in normal JS is safe: no other JS code can run in the middle of it.

But races come back at every `await`. When you `await`, your function pauses and **other code runs**. Any check you did before the `await` may be stale after it.

```js
let balance = 100;
const db = { read: async () => balance, write: async (v) => { balance = v; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withdraw(amount) {
  const current = await db.read();      // read
  await sleep(10);                       // other requests run here!
  if (current < amount) throw new Error("insufficient funds");  // check (stale!)
  await db.write(current - amount);      // write
}

// top-level await: paste into a browser console or an .mjs file
await Promise.all([withdraw(80), withdraw(80)]);
console.log(balance);  // 20 — both succeeded, $160 withdrawn
```

This is the ATM bug, in single-threaded JavaScript. One fix is an async mutex, a queue of promises:

```js
class Mutex {
  #tail = Promise.resolve();
  lock() {                                   // resolves to an unlock function
    let unlock;
    const released = new Promise((r) => (unlock = r));
    const ready = this.#tail.then(() => unlock);
    this.#tail = this.#tail.then(() => released);
    return ready;
  }
}
const m = new Mutex();
async function safeWithdraw(amount) {
  const unlock = await m.lock();
  try { /* read, check, write as before */ } finally { unlock(); }
}
```

In a real system with many server processes, an in-memory mutex is not enough: process A cannot see process B's lock. The fix moves into the database: an atomic conditional update, `UPDATE accounts SET balance = balance - 80 WHERE id = 1 AND balance >= 80`, or a transaction with row locks (Day 22). The pattern is the same; the lock just lives somewhere everyone shares.

### Async vs parallel in Node

| Tool | Concurrency? | Parallel JS? | Shared memory? | Use for |
|---|---|---|---|---|
| `async`/`await`, promises | yes | no (one thread) | n/a | I/O-heavy work (DB, HTTP) |
| `worker_threads` | yes | yes | only via `SharedArrayBuffer` | CPU-heavy work in one process |
| multiple processes (cluster) | yes | yes | no (message passing) | using all cores for a server |

## The math

**How many interleavings?** Two threads, each doing 3 atomic steps. A schedule is choosing which 3 of the 6 time slots belong to thread 1:

```text
C(6, 3) = 6! / (3! × 3!) = 20 possible interleavings
two threads × 10 steps each: C(20, 10) = 184,756
```

Testing cannot cover them all, which is why races hide. You must reason about them.

**A lock caps throughput.** If every request must hold one global lock for 50 µs, then no matter how many cores you add:

```text
max throughput = 1 / 50 µs = 20,000 requests per second
```

That's a serial bottleneck (Amdahl's law, Day 52). Finer-grained locks (one per account instead of one global) remove the cap for unrelated keys.

## In an interview

Races are everywhere in system design: two users booking the last seat, double-charging a card, inventory going negative, two workers processing the same job. Interviewers listen for:

- Spotting the **check-then-act** or **read-modify-write** gap.
- Choosing a fix at the right level: atomic DB update, transaction with row lock, optimistic version check, unique constraint, or idempotency key (Day 43).
- Knowing the cost of locking (contention, deadlock) and how to avoid deadlock (lock ordering, timeouts).

Example answer for "two users book the last seat": *"Reading 'seat free' and then writing 'booked' is a race. I'd make the booking a single atomic conditional update, `UPDATE seats SET user_id = ? WHERE id = ? AND user_id IS NULL`, and check that exactly one row changed; the loser gets 'seat taken'. A unique constraint on (event, seat) is a second safety net."*

## Common mistakes

- **"JavaScript is single-threaded, so it has no races."** It has no *data* races in plain code, but async interleaving at `await` causes logical races.
- **"It passed the tests, so there's no race."** Races depend on timing; tests rarely hit the bad interleaving.
- **Locking reads but not writes (or vice versa).** Every access needs the same lock.
- **Holding a lock across a network call.** That turns a 1 µs critical section into a 50 ms one.
- **Locking in inconsistent order.** Recipe for deadlock.

## Before moving on

- [ ] I can explain a race condition with the ATM example
- [ ] I can explain why `count++` is not atomic across threads
- [ ] I can list the four deadlock conditions and one way to break each
- [ ] I can spot a check-then-act race across an `await`
- [ ] I can explain concurrency vs parallelism in one sentence each

## Go deeper (optional)

- [Race condition — Wikipedia](https://en.wikipedia.org/wiki/Race_condition)
- [Deadlock — Wikipedia](https://en.wikipedia.org/wiki/Deadlock_(computer_science))
- [Atomics — MDN](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Atomics)
- [Node.js worker_threads documentation](https://nodejs.org/api/worker_threads.html)
- *Operating Systems: Three Easy Pieces*, the Concurrency part
