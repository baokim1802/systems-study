# Availability Math and SLOs

> "We need 99.99% uptime" sounds like a wish until you can turn it into minutes of downtime, see what your dependencies do to it, and decide how much risk you can spend on shipping features. That arithmetic is the language of reliability teams and of interviewers.

## The big idea

Think of a chain of Christmas lights wired one after another: if **any** bulb fails, the whole string goes dark. Now think of two separate strings plugged in side by side: the room only goes dark if **both** fail.

Systems work the same way:

- Components a request must pass through **in sequence** (load balancer → app → database) are like the single string. Each one adds a chance to fail.
- **Redundant** copies (two app servers, a database with a standby) are like the parallel strings. They multiply the chances of *both* failing, which is tiny.

**Availability** is the fraction of time (or of requests) a system works correctly. We write it as a percentage, usually in "nines".

## Nines and downtime

One year = 365 days = 8,760 hours = 525,600 minutes. A 30-day month = 43,200 minutes.

| Availability | Nickname | Downtime per year | Per 30-day month | Per day |
|---|---|---|---|---|
| 99% | two nines | 3.65 days (87.6 h) | 7.2 h | 14.4 min |
| 99.9% | three nines | 8.76 h | 43.2 min | 1.44 min |
| 99.95% | three and a half | 4.38 h | 21.6 min | 43.2 s |
| 99.99% | four nines | 52.6 min | 4.32 min | 8.6 s |
| 99.999% | five nines | 5.26 min | 25.9 s | 0.86 s |

Each extra nine cuts allowed downtime by **10×**. A handy shortcut: **99.999% ≈ 5 minutes a year**, and each nine you remove multiplies by 10 (≈ 50 min, ≈ 8.8 h, ≈ 3.65 days).

Notice what four nines means in practice: **4 minutes a month**. A human can't even get paged, open a laptop, and roll back in 4 minutes. Four or five nines require automation: automatic failover, automatic rollbacks, redundancy everywhere.

```js
function downtime(availabilityPct) {
  const down = 1 - availabilityPct / 100;
  const minPerYear = 525600 * down;
  return {
    perYearHours: +(minPerYear / 60).toFixed(2),
    perMonthMinutes: +(43200 * down).toFixed(2),
  };
}
console.log(downtime(99.9));  // { perYearHours: 8.76, perMonthMinutes: 43.2 }
console.log(downtime(99.99)); // { perYearHours: 0.88, perMonthMinutes: 4.32 }
```

## Serial: availabilities multiply

If a request needs components A **and** B **and** C, and they fail independently:

```text
A_total = A1 × A2 × A3
```

Example: load balancer 99.99%, app 99.9%, database 99.95%.

```text
0.9999 × 0.999 × 0.9995
= 0.9999 × 0.9985005
= 0.99840 → 99.84%
```

The total is **worse than the worst part**. That's the first surprise: adding a dependency always lowers availability. A service that calls 10 other services, each at 99.9%, gets at most `0.999^10 ≈ 0.990` → **99.0%**, about 3.65 days of downtime a year, even though each piece looks great.

## Parallel: unavailabilities multiply

If you have redundant copies and the system works as long as **at least one** works:

```text
A_total = 1 − (1 − A)^n          (n identical copies)
```

Two app servers at 99%:

```text
1 − (0.01)² = 1 − 0.0001 = 0.9999 → 99.99%
```

Two mediocre servers make a four-nines pair! Three copies: `1 − 0.01³ = 99.9999%`.

**Big caveat:** this assumes failures are **independent**. Two servers in the same rack, on the same bad deploy, or behind the same misconfigured load balancer fail *together*. Real redundancy means different availability zones, staggered deploys, and no shared single point of failure. Also, the failover mechanism itself must work; an untested failover is just hope.

### Combine them

```text
          ┌── app 99% ──┐
LB 99.99% ┤             ├── DB primary+standby (each 99.9%)
          └── app 99% ──┘

app pair = 1 − 0.01²      = 0.9999
DB pair  = 1 − 0.001²     = 0.999999
total    = 0.9999 × 0.9999 × 0.999999 ≈ 0.99980 → 99.98%
```

Code for both rules:

```js
const serial = (...parts) => parts.reduce((acc, a) => acc * a, 1);
const parallel = (...parts) => 1 - parts.reduce((acc, a) => acc * (1 - a), 1);

const total = serial(0.9999, parallel(0.99, 0.99), parallel(0.999, 0.999));
console.log((total * 100).toFixed(3) + '%'); // 99.980%
```

## MTBF and MTTR

Another way to see availability:

```text
availability = MTBF / (MTBF + MTTR)
```

- **MTBF** (mean time between failures): how long it typically runs before breaking.
- **MTTR** (mean time to recovery): how long it takes to fix.

A service failing once a month (MTBF ≈ 720 h) that takes 1 h to recover: `720 / 721 = 99.86%`. Cut recovery to 6 minutes (0.1 h): `720 / 720.1 = 99.986%`. **Faster recovery is often cheaper than fewer failures**: good alerts, quick rollbacks, and automated failover move MTTR the most.

## SLI, SLO, SLA

These three terms come from Google's Site Reliability Engineering (SRE) practice and get mixed up constantly.

| Term | What it is | Example |
|---|---|---|
| **SLI** — service level *indicator* | A measurement | % of HTTP requests that returned non-5xx in under 300 ms |
| **SLO** — service level *objective* | Your internal target for the SLI over a window | 99.9% of requests good, over 30 days |
| **SLA** — service level *agreement* | A contract with customers, with consequences | 99.5% monthly or we refund 10% of the bill |

The SLA is usually **looser** than the SLO, so you notice and fix problems before you owe anyone money.

Good SLIs measure what **users** experience: success rate and latency at the load balancer, not CPU usage. Most teams use **request-based** SLIs (`good requests / total requests`), which handle "the site was slow for 10% of people" better than "was it up or down".

## Error budgets

If your SLO is 99.9%, you're *allowed* to fail 0.1%. That allowance is the **error budget**.

```text
SLO: 99.9% over 30 days, traffic: 50,000,000 requests / 30 days
error budget = 0.1% × 50,000,000 = 50,000 failed requests
```

The budget turns reliability into a shared decision:

- Budget left? Ship features, run experiments, do risky migrations.
- Budget spent? Freeze risky launches and spend time on reliability until it recovers.

It also says 100% is the **wrong** target: users can't tell 99.999% from 100% (their own Wi-Fi fails more often), and chasing it makes every change slow and expensive.

### Burn rate

**Burn rate** is how fast you're using the budget compared to "evenly over the window". Burn rate 1 = you'll use exactly the whole budget by the end of the 30 days. Burn rate 10 = you'd use it all in 3 days.

```text
Example: 20,000 of 50,000 failures used in the first 10 days
fraction of budget used = 20,000 / 50,000 = 40%
fraction of window gone = 10 / 30       ≈ 33%
burn rate = 0.40 / 0.333 = 1.2   → on track to blow the budget by day 25
```

Google's SRE Workbook suggests alerting on burn rate: for example, page someone if the burn rate over the last hour is above **14.4**, because that rate spends **2%** of a 30-day budget in a single hour (`14.4 × 1 h / 720 h = 0.02`). This ties into alerting on Day 46.

## In an interview

You'll hear "the system must be highly available" in nearly every design question. Turn it into numbers: *"Let's target 99.9% for the read path — about 43 minutes of downtime a month."* Then show you know how dependencies and redundancy affect it.

A strong answer: *"Serial dependencies multiply, so a request touching five 99.9% services is at best about 99.5%. To get back up I'd remove dependencies from the critical path (cache, async work through a queue) and add redundancy across availability zones, since parallel copies multiply the unavailability: two 99% replicas give 99.99% if failures are independent. I'd define SLIs at the load balancer — success rate and p99 latency — set an SLO a bit tighter than any SLA, and use the error budget and burn-rate alerts to decide when to slow down launches."*

## Common mistakes

- **Adding availabilities instead of multiplying.** Serial: multiply availabilities. Parallel: multiply *unavailabilities*.
- **Forgetting correlation.** Two replicas in one zone are not independent.
- **Targeting 100%.** It's impossible and freezes development. Pick an SLO users actually need.
- **SLIs on machine metrics.** CPU at 90% isn't an outage; users getting 500s is.
- **Confusing SLO and SLA.** The SLO is your goal; the SLA is a promise with penalties, and should be looser.

## Before moving on

- [ ] I can recite downtime per year and per month for 99.9% and 99.99%
- [ ] I can compute serial and parallel availability, and combinations
- [ ] I can explain why redundancy needs independent failures
- [ ] I can define SLI, SLO, SLA with an example of each
- [ ] I can compute an error budget and a burn rate

## Go deeper (optional)

- [Google SRE Book: Service Level Objectives](https://sre.google/sre-book/service-level-objectives/)
- [Google SRE Book: Embracing Risk](https://sre.google/sre-book/embracing-risk/)
- [Google SRE Workbook: Alerting on SLOs](https://sre.google/workbook/alerting-on-slos/)
- [Wikipedia: High availability](https://en.wikipedia.org/wiki/High_availability)
