# How JavaScript Runs

> You write JavaScript as text; somehow it becomes machine code running on a CPU, and a single thread serves thousands of users at once. Understanding the engine and the event loop lets you predict the order of `setTimeout` and promises, know why one slow loop freezes a whole Node server, and answer "how does Node handle concurrency?" with confidence.

## The big idea

Two ways to get a speech from Spanish into English:

- **Translate the whole book first** (a *compiler*): slow to start, but the result reads fast, as many times as you like.
- **A live interpreter** standing next to the speaker (an *interpreter*): starts instantly, but each sentence is translated on the fly, every time.

Modern JavaScript engines do something smarter: start with the live interpreter, **notice which sentences get repeated a lot**, and quietly write polished translations of just those. That is a **JIT** (just-in-time) compiler.

And to serve many people with one worker, JavaScript uses a restaurant trick: a single waiter (one thread) never stands at the kitchen waiting for food. They take an order, hand it to the kitchen, and go serve someone else; when a dish is ready, the kitchen rings a bell and the waiter picks it up. That is the **event loop**.

## Compilers, interpreters and JIT

| | Compiled ahead of time (C, Rust, Go) | Interpreted (classic) | JIT (V8, JVM) |
|---|---|---|---|
| When translated | before the program runs | statement by statement, while running | starts interpreting, compiles hot code while running |
| Startup | instant (already machine code) | instant | fast |
| Peak speed | very high | low | high for hot code |
| Knows real runtime types? | no (needs types in source) | yes, but doesn't exploit them | yes, and optimizes for them |

A JIT's superpower is that it can watch the program. If a function `add(a, b)` has been called 10,000 times and `a` and `b` were always small integers, it can compile a version that just does an integer add, without checking for strings, objects or `undefined`.

## Inside V8

**V8** is the JavaScript engine in Chrome, Node.js, Deno and Edge. Its pipeline, simplified:

```text
source text
   │  parse
   v
AST (abstract syntax tree: the code as a tree of nodes)
   │  compile (fast, simple)
   v
bytecode ──> Ignition interpreter runs it, and records type feedback
   │                    ("x was always a small integer here")
   │  function gets "hot"
   v
Sparkplug / Maglev (quick compilers) ──> TurboFan (optimizing compiler)
   │                                         │
   v                                         v
OK machine code                       very fast machine code
                         ^                   │
                         └── deoptimize ─────┘  if an assumption breaks
```

**Deoptimization** is the catch. If TurboFan compiled `add` assuming integers and you suddenly call `add("a", {})`, the optimized code is thrown away and execution falls back to the slower tiers.

V8 also tracks object **shapes** (called hidden classes or "maps"): objects created with the same properties in the same order share a shape, so property access can be compiled into "read the value at offset 16" and cached (an **inline cache**). Practical advice that falls out of this:

```js
// Consistent shapes: good
function Point(x, y) { this.x = x; this.y = y; }
const pts = [new Point(1, 2), new Point(3, 4)];

// Shape chaos: slower property access in hot code
const a = { x: 1 }; a.y = 2;           // shape {x} then {x,y}
const b = { y: 2, x: 1 };              // different order = different shape
delete a.x;                            // delete often drops the object to a slow "dictionary" mode
```

You don't need to micro-optimize everyday code. But this explains why "monomorphic" (one shape) hot paths are fast, and why benchmarks warm up before measuring.

## The call stack

The engine keeps track of "which function is running and where to return to" on the **call stack**. Calling a function pushes a **frame** (its arguments, local variables, return address); returning pops it.

```js
function c() { console.trace(); }   // prints the stack: c, b, a, (main)
function b() { c(); }
function a() { b(); }
a();
```

```text
 ┌─────────┐
 │  c()    │  ← top: running now
 │  b()    │
 │  a()    │
 │ (main)  │
 └─────────┘
```

The stack has a fixed size. Infinite recursion fills it: `RangeError: Maximum call stack size exceeded`, typically after about 10,000 frames in Node (it depends on frame size). Day 10 covers the stack vs heap in detail.

**Crucially, JavaScript has one call stack**: your code runs on one thread, one function at a time. Nothing else in JS can run until the stack is empty.

## The event loop

If there is only one thread, how does `setTimeout`, `fetch`, or reading a file not freeze everything? Because the **waiting** happens outside your JavaScript:

```text
  your JS (one thread)                      the host (browser or Node/libuv)
  ┌──────────────┐  setTimeout, fetch,      ┌─────────────────────────────┐
  │  call stack  │ ───── fs.readFile ─────> │ timers, network (epoll),    │
  └──────┬───────┘                          │ thread pool for file I/O... │
         ^                                  └──────────────┬──────────────┘
         │ when the stack is empty:                        │ done → queue callback
         │ 1. run ALL microtasks                           v
         │ 2. then ONE macrotask      ┌───────────────────────────────────┐
         └────────────────────────────│ microtask queue: promise .then,   │
                                      │   await continuations, queueMicro │
                                      │ macrotask queue: timers, I/O,     │
                                      │   setImmediate, UI events         │
                                      └───────────────────────────────────┘
```

The loop, in words:

1. Run the current script until the call stack is empty.
2. Run **every** microtask in the microtask queue (including any new ones added meanwhile).
3. Take **one** macrotask (a timer callback, an I/O callback...), run it.
4. Go to step 2. (Browsers also render between tasks, when needed.)

- **Microtasks**: promise callbacks (`.then`, code after `await`), `queueMicrotask`. "As soon as the current code finishes."
- **Macrotasks** (just "tasks" in the spec): `setTimeout`, `setInterval`, I/O callbacks, `setImmediate`, clicks.

### The classic puzzle

```js
console.log("A");
setTimeout(() => console.log("B"), 0);
Promise.resolve().then(() => console.log("C"));
queueMicrotask(() => console.log("D"));
(async () => { console.log("E"); await null; console.log("F"); })();
console.log("G");
// Output: A E G C D F B
```

Why: `A`, `E` (an async function runs synchronously until its first `await`), `G` are synchronous. Then the stack is empty, so all microtasks run in the order they were queued: `C`, `D`, `F`. Only then the timer macrotask: `B`. `setTimeout(fn, 0)` means "at least 0 ms, and after the current work and all microtasks", not "now".

## Node.js and libuv

Node is V8 plus a C library called **libuv** that provides the event loop and asynchronous I/O.

- **Network I/O** (sockets): libuv uses the OS's readiness notification (`epoll` on Linux, `kqueue` on macOS, IOCP on Windows). One thread can watch tens of thousands of sockets and get told "these 7 have data" (Day 06's syscalls).
- **Things the OS can't do asynchronously** (most file system calls, `dns.lookup`, CPU-heavy `crypto` like `pbkdf2`/`scrypt`, `zlib`): libuv runs them on a **thread pool** of **4 threads by default** (change with the `UV_THREADPOOL_SIZE` environment variable).

Node's loop runs in **phases**, each with its own queue:

```text
   ┌─> timers          (setTimeout / setInterval callbacks that are due)
   │   pending callbacks
   │   poll            (wait for I/O, run I/O callbacks)
   │   check           (setImmediate callbacks)
   └── close callbacks (socket.on("close"))
 between every callback: process.nextTick queue, then promise microtasks
```

`process.nextTick` callbacks run even before promise microtasks. Inside an I/O callback, `setImmediate` always fires before a `setTimeout(fn, 0)`, because the check phase comes right after poll.

So Node is **single-threaded for your JavaScript**, but not for I/O. Thousands of requests can be "in flight" waiting on the database while one thread runs whichever callback is ready.

## Blocking the event loop

The flip side: while your JavaScript is running, **nothing else can**. No other request, no timer, no I/O callback.

```js
const http = require("http");
http.createServer((req, res) => {
  if (req.url === "/slow") {
    const end = Date.now() + 2000;
    while (Date.now() < end) {}            // 2 s of pure CPU: blocks EVERYONE
  }
  res.end("ok\n");
}).listen(3000);
// While /slow runs, a request to / also waits ~2 s.
```

Common event-loop blockers: `JSON.parse` of a 50 MB body, a synchronous `fs.readFileSync` in a request handler, a huge `array.sort`, catastrophic regex backtracking, password hashing with sync APIs, and endless microtask chains (a promise loop that never yields starves timers and I/O).

Fixes: use async APIs, split work into chunks (`setImmediate` between chunks), move CPU-heavy work to `worker_threads` or another service, and run one Node process per core (Day 04, Day 06).

## The math

**CPU time per request caps throughput.** If each request needs 2 ms of JavaScript CPU time (parsing, logic, serializing), one Node process can do at most:

```text
1 / 0.002 s = 500 requests per second   (per process, i.e. per core)
on an 8-core box with 8 processes: ~4,000 req/s
```

Waiting on I/O doesn't count: a request that waits 50 ms for the database but uses 2 ms of CPU still allows ~500 req/s, with ~25 requests in flight at once (`500/s × 0.05 s`, a preview of Little's Law, Day 52).

**The thread pool can be the bottleneck.** `crypto.pbkdf2` with settings that take 100 ms per hash, on the default 4 pool threads:

```text
max = 4 threads × (1 / 0.1 s) = 40 hashes per second
the 5th concurrent login waits for a free thread
UV_THREADPOOL_SIZE=8 on an 8-core machine → ~80 hashes/s
```

You can watch this happen: start 8 `pbkdf2` calls at once and the first four finish together, the next four take about twice as long.

## In an interview

- "How does Node handle 10,000 concurrent connections on one thread?" Non-blocking I/O via libuv and the OS (epoll); the thread only runs short callbacks; waiting costs no thread.
- "When is Node a bad fit?" CPU-heavy work per request (video encoding, big computations) unless offloaded.
- "Order of these logs?" Sync code, then all microtasks, then macrotasks.
- "Why did p99 latency spike for all endpoints?" Something blocked the event loop; measure event-loop lag.

A strong summary: *"V8 parses JS to bytecode, interprets it while collecting type feedback, and JIT-compiles hot functions to optimized machine code, deoptimizing if assumptions break. JS runs on a single call stack; async work is handed to the host (libuv in Node, which uses epoll for sockets and a 4-thread pool for file/crypto work). When the stack empties, the event loop drains all microtasks (promises), then runs the next macrotask (timers, I/O). That makes Node great for I/O-bound concurrency, but any long synchronous CPU work blocks every request."*

## Common mistakes

- **"JavaScript is interpreted, so it's slow."** Hot code is JIT-compiled to machine code; V8 is fast.
- **"`setTimeout(fn, 0)` runs immediately."** It runs after the current code and all microtasks, and Node/browsers may clamp the delay.
- **"Node is single-threaded, so it can't do parallel I/O."** Your JS is single-threaded; I/O happens in the OS and libuv's thread pool.
- **"async functions run in the background."** An `async` function runs synchronously until its first `await`. CPU work inside it still blocks.
- **"Promises and timers share one queue."** Microtasks always drain before the next macrotask.

## Before moving on

- [ ] I can explain compiler vs interpreter vs JIT in my own words
- [ ] I can sketch V8's pipeline (parse → bytecode → optimized code, and deopt)
- [ ] I can predict the output of a puzzle mixing sync code, promises and timers
- [ ] I can explain what libuv does and what goes to its thread pool
- [ ] I can explain why a CPU-heavy handler slows every request in Node

## Go deeper (optional)

- [The event loop — MDN](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Event_loop)
- [The Node.js Event Loop — Node.js docs](https://nodejs.org/en/learn/asynchronous-work/event-loop-timers-and-nexttick)
- [Don't Block the Event Loop — Node.js docs](https://nodejs.org/en/learn/asynchronous-work/dont-block-the-event-loop)
- [V8 blog](https://v8.dev/blog)
- [Just-in-time compilation — Wikipedia](https://en.wikipedia.org/wiki/Just-in-time_compilation)
