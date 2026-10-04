# Performance and Queueing Theory

> Why does a server that is "only 90% busy" feel ten times slower than one at 50%? Three small laws (Little's Law, the queueing curve, and Amdahl's Law) explain most performance surprises, and they let you size systems with arithmetic instead of guesswork.

## The big idea

Picture a coffee shop with one barista who takes exactly 1 minute per drink.

- If a customer walks in every 2 minutes, the barista is busy half the time and nobody waits much.
- If a customer walks in every 1.1 minutes, the barista is busy 91% of the time. On average that sounds fine. But customers don't arrive on a neat schedule: sometimes three walk in together. Each burst creates a line, and with only 9% slack, the line takes ages to drain before the next burst arrives.

That is the core of queueing theory: **waiting time explodes as you approach full utilization**, because of randomness. Servers, databases, thread pools and network links are all baristas.

## Latency vs throughput

Two words people use loosely:

| Term | Question it answers | Units | Coffee shop |
|---|---|---|---|
| **Latency** (response time) | How long does *one* request take? | ms | minutes from walking in to getting your drink |
| **Throughput** | How many requests finish per unit of time? | requests/s | drinks served per hour |
| **Utilization** | What fraction of time is the resource busy? | % | fraction of time the barista is working |

They are related but different. A highway can have high throughput (many cars per hour) and terrible latency (traffic jam). Adding a second barista doubles throughput but doesn't make any single drink faster. Batching (Day 54 will show it for GPUs) often *raises* throughput while *raising* latency too.

Latency also splits into **service time** (actually doing the work) plus **wait time** (sitting in a queue). Under load, wait time is usually the bigger part.

## Little's Law

The most useful formula in this whole course:

```text
L = λ × W

L = average number of items in the system (in progress + waiting)
λ = arrival rate (items per second)       λ is the Greek letter "lambda"
W = average time each item spends in the system
```

It holds for almost any stable system, no matter the arrival pattern. Examples:

```text
Coffee shop: 30 customers/hour, each stays 0.5 hours  → L = 30 × 0.5 = 15 people inside
Web server: 2,000 req/s, each takes 50 ms            → L = 2,000 × 0.05 = 100 requests in flight
Database:   500 queries/s, each takes 20 ms          → 500 × 0.02 = 10 connections busy on average
```

Why it matters:

- **Sizing pools.** If each request holds a DB connection for 20 ms at 500 queries/s, you need about 10 connections on average; give the pool headroom (say 20–30) for bursts.
- **Finding hidden slowness.** If in-flight requests jump from 100 to 1,000 while traffic is flat, `W` must have grown 10x: something downstream got slow.
- **Concurrency limits.** A server that handles at most 200 concurrent requests and needs 100 ms per request can sustain at most `200 / 0.1 = 2,000 req/s`.

## Utilization and the hockey stick

For the simplest model (one server, random arrivals, random service times; textbooks call it **M/M/1**):

```text
ρ = λ / μ                          utilization: arrival rate / service rate   (ρ is "rho")
average response time  W = S / (1 − ρ)        S = average service time
```

With `S = 10 ms`:

| Utilization ρ | `1 / (1 − ρ)` | Avg response time |
|---|---|---|
| 50% | 2x | 20 ms |
| 80% | 5x | 50 ms |
| 90% | 10x | 100 ms |
| 95% | 20x | 200 ms |
| 99% | 100x | 1,000 ms |

```text
response
 time
  │                                  │
  │                                 ╱
  │                               ╱
  │                           _-─
  │               ____----‾‾‾
  │_____-----‾‾‾‾
  └──────────────────────────────────── utilization
  0%        50%        80%   90%  100%
```

Going from 50% to 90% busy only adds 80% more load, but response time goes up **5x**. That's why capacity plans target 50–70% utilization at peak, and why "the CPU is only at 85%" is not reassuring.

You don't have to trust the formula. Simulate it:

```js
// One server, random arrivals, random service times (an M/M/1 queue).
function simulate(utilization, serviceMs = 10, n = 200000) {
  const exp = (mean) => -mean * Math.log(1 - Math.random());
  const arrivalGap = serviceMs / utilization;   // mean ms between arrivals
  let clock = 0, serverFreeAt = 0, totalTime = 0;
  for (let i = 0; i < n; i++) {
    clock += exp(arrivalGap);                    // next request arrives
    const start = Math.max(clock, serverFreeAt); // wait if server is busy
    serverFreeAt = start + exp(serviceMs);       // do the work
    totalTime += serverFreeAt - clock;           // wait + work
  }
  return (totalTime / n).toFixed(1);
}
for (const u of [0.5, 0.8, 0.9, 0.95]) {
  console.log(`utilization ${u * 100}%: avg response ${simulate(u)} ms`);
}
// utilization 50%: avg response 20.0 ms
// utilization 80%: avg response 50.3 ms
// utilization 90%: avg response 99.4 ms
// utilization 95%: avg response 201.8 ms
```

If arrivals are *more* bursty than random (they often are), the curve is even worse. If arrivals exceed capacity (`ρ > 1`), the queue grows forever: this is overload, and the only fixes are more capacity, less work, or **shedding load** (rejecting some requests quickly, like rate limiting on Day 35).

## Tail latency and fan-out

Averages hide pain (Day 46). Now combine that with fan-out: one user request that calls 100 backend servers in parallel must wait for the **slowest** of them.

```text
Each backend is slow (> 1 s) on 1% of calls.
P(user request avoids all slow calls) = 0.99^100 ≈ 0.366
P(user request is slow)               ≈ 63%
```

A 1-in-100 problem per server becomes a 63-in-100 problem per user. That's why big systems obsess over **p99** and use tricks like **hedged requests**: if a backend hasn't answered by its p95 time, send the same request to a second replica and take whichever answers first.

## Amdahl's Law: the limit of adding more workers

If a fraction `p` of a job can be parallelized and the rest can't:

```text
speedup with n workers = 1 / ((1 − p) + p / n)
```

Example: 90% of a job is parallel (`p = 0.9`):

```text
n = 10   → 1 / (0.1 + 0.09)   = 5.3x     (not 10x)
n = 100  → 1 / (0.1 + 0.009)  = 9.2x
n = ∞    → 1 / 0.1            = 10x      the hard ceiling
```

The serial 10% (a single lock, a single leader, one database row everyone updates) caps you at 10x forever. In system design this is the argument for removing **serialization points**: shard the hot counter (Day 32), avoid global locks (Day 7), partition the queue (Day 34).

## Finding the bottleneck: profiling

Rules before you optimize:

1. **Measure, don't guess.** Programmers are famously bad at guessing where time goes.
2. **Find the bottleneck resource.** Is it CPU (100% busy), memory (swapping, GC pauses from Day 10), disk IO, network, or *waiting* on another service or a lock?
3. **Optimize the biggest slice.** Speeding up something that takes 5% of the time can save at most 5%. That's Amdahl again.

Tools in the JavaScript world:

```js
// Quick timing
const t0 = performance.now();
doWork();
console.log(`doWork took ${(performance.now() - t0).toFixed(1)} ms`);
```

```text
node --cpu-prof app.js      writes a .cpuprofile you open in Chrome DevTools
node --inspect app.js       attach Chrome DevTools, use the Performance tab
```

A **flame graph** shows which functions were on the CPU: each bar is a function, its width is how much time was spent in it (including the functions it called). Look for the widest bars near the top.

A **load test** (tools like k6, wrk, JMeter) sends increasing traffic and records throughput and latency percentiles. Plot latency against requests per second; the "knee" where latency shoots up is your real capacity. Plan to run below it.

## The math: sizing a service

You expect 3,000 req/s at peak. Each request uses 20 ms of CPU on one core. Machines have 8 cores. Target 60% utilization.

```text
CPU work per second = 3,000 × 0.020 s = 60 core-seconds per second = 60 busy cores
at 60% target       = 60 / 0.6 = 100 cores
machines            = 100 / 8 = 12.5 → 13 machines, +1–2 for a machine failing → ~15
in-flight requests  = 3,000 × (say 80 ms total latency) = 240 (Little's Law)
```

## In an interview

Interviewers love candidates who reason quantitatively. Phrases that land: "by Little's Law, at 5k req/s and 200 ms we'll have about 1,000 concurrent requests, so we need connection pooling", "we'll size for 60% utilization because latency grows like `1/(1−ρ)`", "with fan-out to 50 shards, tail latency dominates, so we'll hedge requests", "this global counter is a serialization point; Amdahl says it caps our scaling".

## Common mistakes

- **Treating latency and throughput as the same thing.** More servers raise throughput; they don't speed up one request.
- **Running hot to save money.** 95% utilization means 20x the service time on average.
- **Optimizing before profiling.** You'll speed up the wrong thing.
- **Ignoring the serial part.** Doubling workers does nothing if everyone waits on one lock.
- **Looking only at averages** in a fan-out system, where p99 of each part becomes the typical case of the whole.

## Before moving on

- [ ] I can state Little's Law and use it to size a connection pool
- [ ] I can explain why response time explodes near 100% utilization, with `S / (1 − ρ)`
- [ ] I can compute the probability a fan-out request hits a slow backend
- [ ] I can apply Amdahl's Law and name a serialization point
- [ ] I can describe how I'd profile a slow Node service

## Go deeper (optional)

- [Little's law (Wikipedia)](https://en.wikipedia.org/wiki/Little%27s_law)
- [Amdahl's law (Wikipedia)](https://en.wikipedia.org/wiki/Amdahl%27s_law)
- [M/M/1 queue (Wikipedia)](https://en.wikipedia.org/wiki/M/M/1_queue)
- Jeffrey Dean and Luiz André Barroso, "The Tail at Scale" (Communications of the ACM, 2013)
- *Systems Performance* by Brendan Gregg
