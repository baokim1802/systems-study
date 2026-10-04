# Observability: Logs, Metrics, and Traces

> When a system with dozens of services gets slow at 3 a.m., you can't attach a debugger to production. Observability is how you build systems that can explain themselves: what's broken, where, and for whom, using the data they already emit.

## The big idea

Think about how a doctor checks on a patient:

- **Metrics** are the vital signs on the monitor: heart rate, blood pressure, temperature. Numbers over time. Cheap to record constantly, great for noticing *that* something is wrong.
- **Logs** are the nurse's notes: "14:02 patient complained of a headache, gave paracetamol". Detailed records of specific events. Great for *what exactly happened*.
- **Traces** are like following one blood cell through the whole body: where it went, how long it spent in each organ. Great for *where the time went* for one request across many services.

These are often called the **three pillars of observability**. **Monitoring** means watching known signals ("is the error rate high?"). **Observability** is the broader ability to answer *new* questions about your system ("why are only Android users in Brazil seeing slow checkouts?") without shipping new code.

## Logs

A **log** is a timestamped record of an event. The big upgrade from `console.log('user logged in')` is **structured logging**: emit JSON with fields, so a machine can search and filter.

```js
function log(level, msg, fields = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }));
}

log('info', 'checkout completed', { userId: 'u_812', orderId: 'o_99', ms: 184, traceId: 'a1b2c3' });
// {"ts":"2026-09-30T10:15:02.123Z","level":"info","msg":"checkout completed","userId":"u_812",...}
```

Good habits:

- **Levels:** `debug` (noisy, usually off in production), `info` (normal events), `warn` (odd but handled), `error` (something failed).
- **Correlation IDs:** put the same request or trace ID in every log line for one request, so you can pull all of them across services.
- **Never log secrets:** passwords, tokens, full card numbers (Day 48).
- **Mind the cost:** a service doing 10,000 requests/s writing 1 KB per request produces `10,000 × 1 KB × 86,400 s ≈ 864 GB per day`. Logs get sampled, shortened, and expired.

Logs from all machines are shipped to a central system (Elasticsearch/OpenSearch, Loki, Splunk, a cloud logging service) where you can search them.

## Metrics

A **metric** is a number measured over time, with a name and some **labels** (key–value tags):

```text
http_requests_total{service="checkout", route="/pay", status="500"}  1423
```

Three basic types (the names used by Prometheus, a popular open-source metrics system):

| Type | What it is | Example |
|---|---|---|
| **Counter** | Only goes up (resets on restart). You look at its *rate*. | requests served, errors |
| **Gauge** | Goes up and down; a current value | memory in use, queue length, open connections |
| **Histogram** | Counts observations into buckets | request duration: how many took ≤50 ms, ≤100 ms, ≤250 ms… |

Metrics are cheap because they're aggregated: a counter costs the same whether you served 10 requests or 10 million.

**Cardinality** is the catch. Every unique combination of label values is a separate time series stored forever-ish. Labels like `status` (≈5 values) and `route` (≈50) are fine: `5 × 50 = 250` series. Add `userId` with 10 million users and you get **2.5 billion** series; the metrics database falls over. Rule: labels for small, bounded sets; put high-cardinality details (user IDs, order IDs) in logs and traces.

### What to measure

Three popular checklists:

- **Four golden signals** (Google SRE book): **latency**, **traffic**, **errors**, **saturation** (how "full" the service is).
- **RED** for request-driven services: **R**ate, **E**rrors, **D**uration.
- **USE** for resources like CPUs, disks, queues: **U**tilization, **S**aturation, **E**rrors.

## Traces

A single click may hit an API gateway, then the orders service, which calls payments and inventory, each of which hits a database. When it takes 2 seconds, which part was slow?

**Distributed tracing** answers this. A **trace** is the full journey of one request. It is made of **spans**: one span per unit of work (an HTTP call, a DB query), each with a start time, duration, and a pointer to its **parent span**.

```text
trace a1b2c3  (total 1,840 ms)
├─ gateway  GET /checkout                    1,840 ms
│  └─ orders  POST /orders                   1,790 ms
│     ├─ inventory  reserve                     40 ms
│     ├─ payments   charge                   1,650 ms   ← here
│     │  └─ http  POST bank-api/authorize    1,610 ms
│     └─ postgres  INSERT orders                 12 ms
```

How it works: the first service creates a **trace ID** and passes it to every downstream call in a header. The W3C standard header is `traceparent`, which carries the trace ID and the parent span ID. Each service reports its spans to a collector. **OpenTelemetry** is the vendor-neutral standard library for producing traces (and metrics and logs).

Tracing every request is expensive, so systems **sample**: keep, say, 1% of traces (**head sampling**, decided at the start), or buffer them and keep all slow or failed ones (**tail sampling**, decided at the end — more useful, more complex).

## Percentiles: why averages lie

Suppose 100 requests: 97 take 20 ms and 3 take 2,000 ms.

```text
average = (97 × 20 + 3 × 2000) / 100 = (1,940 + 6,000) / 100 = 79.4 ms
```

79.4 ms describes **nobody**: 97 people waited 20 ms and 3 people waited 2 seconds. Percentiles describe the real distribution:

- **p50** (median): half the requests are faster than this. Here **20 ms**.
- **p99**: 99% are faster than this; it shows the slow tail. Here **2,000 ms**.

The slow tail matters more than it seems. Your most active users make the most requests, so they hit the tail most often. And one web page may make dozens of requests, so most page loads include at least one slow one.

### Computing a percentile

The simple **nearest-rank** method: sort the values, then take the value at rank `ceil(p/100 × n)` (1-based).

```js
function percentile(values, p) {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b); // numeric sort!
  const rank = Math.ceil((p / 100) * sorted.length);  // 1-based
  return sorted[Math.max(rank, 1) - 1];
}

const latencies = [...Array(97).fill(20), 2000, 2000, 2000];
console.log(percentile(latencies, 50)); // 20
console.log(percentile(latencies, 99)); // 2000  (rank 99 of 100)
```

Real metrics systems don't keep every value; they use **histograms** (count per bucket) and estimate percentiles from the buckets. A key fact: **you can't average percentiles**. If server A's p99 is 100 ms and server B's is 900 ms, the fleet's p99 is *not* 500 ms; it depends on how many requests each served. Histograms can be added bucket by bucket across servers, then you compute the percentile from the merged histogram.

## The math: tail latency at scale

A request **fans out** to 100 backend servers and must wait for all of them. Each server is slow (say >1 s) only 1% of the time. How often is the whole request slow?

```text
P(no server slow) = 0.99^100 ≈ 0.366
P(at least one slow) = 1 − 0.366 ≈ 0.634  → 63% of requests!
```

With 10 servers: `1 − 0.99^10 ≈ 9.6%`. This is the core of the paper *The Tail at Scale* (Dean and Barroso, 2013): at scale, rare slowness in parts becomes common slowness in the whole. That's why large systems watch p99 and p99.9, and use tricks like **hedged requests** (send a backup request if the first is slow).

## Alerting

Collecting data is useless if no one notices problems, and harmful if everyone is paged for nothing.

- **Alert on symptoms, not causes.** Page when *users* are hurting ("checkout error rate above SLO burn", Day 45), not when a CPU is at 80%. Causes go on dashboards.
- **Every page must be actionable and urgent.** If the right response is "look at it tomorrow", make it a ticket, not a page.
- **Avoid alert fatigue.** A team that gets 50 noisy alerts a week starts ignoring all of them, including the real one.
- **Use burn-rate alerts** on your SLOs: fast burn (budget disappearing within hours) pages; slow burn (on track to miss this month) creates a ticket.
- **Link alerts to runbooks**: a short doc saying what this alert means and what to check first.

## In an interview

Observability usually comes up near the end: *"How would you know this system is healthy? How would you debug a latency spike?"* Interviewers want the three pillars, percentiles over averages, and symptom-based alerting.

A strong answer: *"Each service emits RED metrics — request rate, error rate, and a latency histogram — with low-cardinality labels like route and status. Dashboards show p50, p99 and p99.9, never just averages, since a 1% slow tail across a 100-way fan-out hits most requests. Every request carries a trace ID via the traceparent header, with tail sampling to keep slow and failed traces, and the same ID appears in our structured JSON logs. Alerts page on SLO burn rate for user-facing symptoms; resource metrics are for diagnosis, not paging."*

## Common mistakes

- **Reporting average latency.** It hides the tail. Use p50/p95/p99.
- **Averaging percentiles across hosts.** Merge histograms instead.
- **High-cardinality labels** like user ID in metrics. Put those in logs or traces.
- **Unstructured logs.** `"error!!"` can't be searched or aggregated.
- **Paging on causes.** High CPU at 3 a.m. with happy users is not an emergency.
- **No correlation ID.** Without it, you can't connect logs across services.

## Before moving on

- [ ] I can explain logs, metrics, and traces and when each is the right tool
- [ ] I can compute p50 and p99 by hand and with code
- [ ] I can explain why averages and averaged percentiles mislead
- [ ] I can work out fan-out tail probability with `1 − 0.99^n`
- [ ] I can describe good alerting: symptoms, actionable, burn rate

## Go deeper (optional)

- [Google SRE Book: Monitoring Distributed Systems](https://sre.google/sre-book/monitoring-distributed-systems/)
- [The Tail at Scale (Dean and Barroso, Communications of the ACM, 2013)](https://research.google/pubs/the-tail-at-scale/)
- [OpenTelemetry documentation](https://opentelemetry.io/docs/)
- [Prometheus: Metric types](https://prometheus.io/docs/concepts/metric_types/)
- [W3C Trace Context](https://www.w3.org/TR/trace-context/)
