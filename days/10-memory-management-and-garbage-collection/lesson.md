# Memory Management and Garbage Collection

> Every object you create lives somewhere in RAM, and someone has to clean it up when you're done. In JavaScript that someone is the garbage collector: understanding it explains memory leaks, mysterious latency spikes on servers, and why "out of memory" crashes happen.

## The big idea

Picture a busy restaurant. There are two kinds of space:

- **The tray in your hands (the stack).** You grab it when you sit down, stack plates on it in order, and when you leave, the whole tray is cleared at once. Fast, tidy, but small, and you can only take things off the top.
- **The tables in the dining room (the heap).** Big, flexible, any size of party can sit anywhere. But nobody automatically clears a table when the guests leave. A **busser** (the garbage collector) walks around, checks which tables still have someone sitting at them, and clears the empty ones.

Programs work the same way. Small, short-lived values with a known size go on the **stack**. Everything that is big, variable-sized or needs to outlive the function call goes on the **heap**. In C you are the busser: you call `malloc` to get heap memory and `free` to give it back, and forgetting either one causes bugs. In JavaScript, Java, Go, Python and C#, a **garbage collector (GC)** does it for you.

## Stack vs heap

**Memory** here means the RAM your process gets (Day 6: each process has its own virtual address space). Inside that space, two regions matter:

| | Stack | Heap |
|---|---|---|
| What lives there | Function call frames: local variables, arguments, return address | Objects, arrays, closures, strings — anything allocated dynamically |
| Allocation | Move one pointer ("stack pointer") down. Almost free. | Find a free chunk of the right size. Slower. |
| Freeing | Automatic when the function returns (pointer moves back) | Manual (C: `free`) or by a garbage collector |
| Size | Small: often 1–8 MB per thread (V8's default is just under 1 MB) | Large: up to GBs |
| Failure mode | Stack overflow (too-deep recursion) | Out of memory, leaks, fragmentation |

You've already met the stack's failure mode:

```js
function forever(n) { return forever(n + 1); }
forever(0); // RangeError: Maximum call stack size exceeded
```

Every call pushes a new **frame** (a small block holding that call's locals). Around ten thousand frames later (the exact number depends on frame size), the stack is full.

## Values and references

A **reference** is like a street address written on a slip of paper. The house is on the heap; the slip can sit in a local variable on the stack.

```js
function demo() {
  let count = 3;                 // small number: lives right in the frame
  let user = { name: "Ada" };    // object on the heap; `user` holds its address
  let alias = user;              // copies the ADDRESS, not the object
  alias.name = "Grace";
  console.log(user.name);        // "Grace" — same object, two references
}
```

```text
 STACK (demo's frame)            HEAP
 +-------------------+           +------------------+
 | count = 3         |           |                  |
 | user  = 0x1A40 ---+---------->| { name: "Grace" }|
 | alias = 0x1A40 ---+---------->|                  |
 +-------------------+           +------------------+
```

When `demo` returns, its frame disappears, and with it both slips of paper. The object is still sitting on the heap, but **nobody can reach it anymore**. That is exactly what "garbage" means: memory that can never be used again because no path leads to it.

(Engines are clever: V8 may keep small integers directly in the frame and can sometimes avoid heap-allocating objects that never escape a function. The mental model above is still the right one.)

## How garbage collectors decide what's garbage

### Idea 1: reference counting

Each object keeps a counter: how many references point at me? When it drops to 0, free it immediately. Simple, and used by Python (CPython), Swift and Objective-C. The fatal flaw is **cycles**:

```js
let a = {}; let b = {};
a.friend = b; b.friend = a;   // a -> b -> a
a = null; b = null;           // nothing outside points in, but each count is still 1
```

Both objects are unreachable but their counts never hit zero. Pure reference counting leaks them. (Python adds a separate cycle detector to cope.)

### Idea 2: tracing — mark and sweep

Modern JS engines use **tracing**. Start from the **roots** (things that are definitely alive) and follow every reference:

- **Roots:** global variables, every variable in every active stack frame, CPU registers, and engine internals.
- **Mark:** walk the graph from the roots, marking each object you reach as "alive".
- **Sweep:** everything not marked is garbage; add its memory to the free list.

```text
 roots ──> A ──> B          Mark phase reaches A, B, C.
           │                D and E point at each other
           └──> C           but nothing reachable points at them.
                             Sweep frees D and E. Cycles are no problem.
      D <──> E
```

Here's a toy version you can run, to make it concrete:

```js
function markAndSweep(roots, heap) {
  const marked = new Set();
  const stack = [...roots];
  while (stack.length) {                       // mark: depth-first walk
    const obj = stack.pop();
    if (marked.has(obj)) continue;
    marked.add(obj);
    for (const ref of obj.refs) stack.push(ref);
  }
  return heap.filter(obj => !marked.has(obj)); // sweep: the garbage
}

const A = { name: "A", refs: [] }, B = { name: "B", refs: [] };
const D = { name: "D", refs: [] }, E = { name: "E", refs: [] };
A.refs.push(B); D.refs.push(E); E.refs.push(D);
console.log(markAndSweep([A], [A, B, D, E]).map(o => o.name)); // ["D", "E"]
```

Real collectors often also **compact**: they slide live objects together so free space becomes one big chunk instead of many small holes (**fragmentation**).

## Generational GC: most objects die young

A key observation, called the **generational hypothesis**: *most objects die young*. Think of the temporary arrays from `.map()`, the objects you build for one HTTP response, the strings you concatenate in a loop. They're garbage within milliseconds.

So V8 splits the heap into generations:

```text
 +---------------------------+   +-----------------------------------+
 | YOUNG generation          |   | OLD generation                    |
 | ("nursery", small: ~1-16MB|   | (large: up to the heap limit,      |
 |  per semi-space)          |   |  often ~2-4 GB on 64-bit Node)    |
 |                           |   |                                   |
 | new objects land here     |   | objects that survived two minor   |
 | collected OFTEN, FAST     |   | GCs get "promoted" here           |
 | ("Scavenger", minor GC)   |   | collected RARELY ("Mark-Compact", |
 |                           |   |  major GC)                        |
 +---------------------------+   +-----------------------------------+
```

Why this is fast: a minor GC's cost depends on the number of **live** objects, not dead ones. If 95% of the nursery is garbage, the collector copies the surviving 5% somewhere else and treats the whole old region as empty again. Allocation in the nursery is just "bump a pointer", nearly as cheap as the stack.

Rough numbers for V8: a minor GC typically takes around 1 ms or less; a full major GC on a heap of hundreds of MB can take tens to hundreds of ms if done all at once. That's why V8 (its GC is called **Orinoco**) does most marking **incrementally** (in small slices between your JS) and **concurrently** (on helper threads), so the main-thread pause stays short.

## Stop-the-world pauses and servers

Some GC work requires **stopping the world**: pausing your JavaScript so the object graph doesn't change mid-walk. For a browser tab, a 50 ms pause is a dropped animation frame (at 60 fps each frame has about 16.7 ms). For a server, it's worse: every request in flight during the pause waits.

The math: suppose a Node server handles 2,000 requests/second, and a major GC pauses it for 100 ms once a minute.

```text
requests arriving during one pause = 2,000 req/s × 0.1 s = 200 requests
pauses per minute                  = 1
requests per minute                = 2,000 × 60 = 120,000
fraction hit by a pause            = 200 / 120,000 ≈ 0.17%
```

0.17% is small, but it lands right in your **p99.9 latency** (the slowest 0.1% of requests; Day 46 covers percentiles). Those 200 requests each get up to +100 ms. This is the classic reason a service with "fast averages" has an ugly tail. Fixes: allocate less (reuse buffers, avoid building huge temporary arrays), keep the heap smaller, tune the heap size, or in other languages choose a low-pause collector (Java's ZGC, Go's concurrent GC aims for sub-millisecond pauses).

## Memory leaks in JavaScript

A GC can't free what's still **reachable**. So a JS "leak" is never "forgot to free"; it's "accidentally kept a reference". The usual suspects:

1. **Ever-growing caches and maps.**
   ```js
   const cache = new Map();
   function getUser(id) {
     if (!cache.has(id)) cache.set(id, loadUser(id)); // never evicted!
     return cache.get(id);
   }
   ```
   On a server with millions of distinct ids, this grows forever. Fix: bound it (an LRU cache, Day 29) or use a `WeakMap` when the key is an object whose lifetime should control the entry.
2. **Forgotten timers and listeners.** `setInterval(() => use(bigData), 1000)` keeps `bigData` alive until `clearInterval`. An `emitter.on("data", handler)` registered per request and never removed keeps every handler (and its closure) alive. Node even warns: `MaxListenersExceededWarning`.
3. **Closures capturing more than you think.** A callback stored somewhere long-lived keeps alive every variable it closes over.
4. **Accidental globals.** In sloppy (non-strict) mode, `total = 0` without `let` creates a global, a root that's never collected.
5. **Detached DOM nodes** (browser): you removed an element from the page but a JS array still references it.

`WeakMap` and `WeakRef` are the language's "this reference shouldn't keep the object alive" tools: a `WeakMap` entry disappears when its key object becomes otherwise unreachable.

### Watching memory in Node

```js
const mb = n => (n / 1024 / 1024).toFixed(1) + " MB";
setInterval(() => {
  const { heapUsed, heapTotal, rss } = process.memoryUsage();
  console.log(`heapUsed ${mb(heapUsed)} / heapTotal ${mb(heapTotal)}, rss ${mb(rss)}`);
}, 5000);
```

A healthy server shows a **sawtooth**: heap climbs, GC drops it, repeat. A leak shows a sawtooth whose *floor keeps rising*. To find the culprit, take two heap snapshots (Chrome DevTools, or `node --inspect`) a few minutes apart and compare which object types grew. If the heap hits the limit you get `FATAL ERROR: ... JavaScript heap out of memory`; `--max-old-space-size=4096` raises the old-generation limit to 4 GB, but that only buys time if you truly leak.

## The math: how fast does a leak kill you?

A server leaks one 2 KB object per request (say, a request object captured by a listener that's never removed). It handles 500 req/s and has a 2 GB heap limit, with 300 MB used normally.

```text
leak rate      = 500 req/s × 2 KB = 1,000 KB/s ≈ 1 MB/s
headroom       = 2,048 MB − 300 MB ≈ 1,750 MB
time to crash  = 1,750 MB ÷ 1 MB/s = 1,750 s ≈ 29 minutes
```

Worse, as the heap fills, each major GC has more live objects to mark, so GCs get longer and more frequent. Latency climbs for many minutes *before* the crash. That "it gets slower and slower, then restarts" pattern is a classic leak signature in interviews and in real incidents.

## In an interview

Memory and GC show up as: "Why is our p99 latency spiky?", "Our Node service's memory grows until it restarts every few hours, how do you debug it?", or as a language-runtime question in a backend interview.

A strong answer sounds like: *"Short-lived values live in stack frames and vanish when the function returns; objects live on the heap and a tracing GC frees whatever isn't reachable from the roots. V8 is generational: new objects go into a small young generation that's collected often and cheaply, survivors get promoted to the old generation, which is collected rarely with mark-compact. In JS a leak means something reachable is holding references, typically an unbounded cache, a listener or timer never removed, or a closure. I'd confirm with `process.memoryUsage()` over time (rising floor of the sawtooth), compare two heap snapshots to see what grows, then fix by bounding or removing the reference. For latency spikes I'd check GC pause times (e.g. `--trace-gc`) and reduce allocation."*

## Common mistakes

- **"Garbage collection means no memory leaks."** GC frees *unreachable* objects. Anything you still reference stays, forever.
- **"Setting a variable to `null` frees the object."** It only removes *one* reference. The object is freed later, by the GC, and only if no other references remain.
- **"Primitives go on the stack, objects on the heap, always."** That's a good model, but engines optimize: strings are usually heap-allocated, and closed-over variables live on the heap so the closure can use them after the function returns.
- **"Reference counting is how JS works."** Modern JS engines use tracing (mark-and-sweep/compact), which handles cycles fine.
- **"More heap fixes it."** A bigger heap delays a leak's crash and can make each full GC *longer*.

## Before moving on

- [ ] I can explain stack vs heap in two sentences, including what goes where
- [ ] I can explain mark-and-sweep and why it handles cycles while reference counting doesn't
- [ ] I can explain the generational hypothesis and why minor GCs are cheap
- [ ] I can name four common JS memory leaks and how to fix each
- [ ] I can estimate how long until a leaking server crashes

## Go deeper (optional)

- [MDN: Memory management](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Memory_management)
- [V8 blog: Trash talk — the Orinoco garbage collector](https://v8.dev/blog/trash-talk)
- [Wikipedia: Tracing garbage collection](https://en.wikipedia.org/wiki/Tracing_garbage_collection)
- [Node.js docs: process.memoryUsage()](https://nodejs.org/api/process.html#processmemoryusage)
