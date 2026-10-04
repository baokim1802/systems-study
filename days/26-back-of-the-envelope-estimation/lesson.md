# Back-of-the-Envelope Estimation

> Before you build anything big, you need to know *how* big. A two-minute estimate tells you whether you need one server or a thousand, one disk or a data center, and interviewers use it to see whether you think in real numbers.

## The big idea

Imagine you're throwing a party and need to buy pizza. You don't count every bite anyone will take. You think: "About 30 people, each eats about 3 slices, a pizza has 8 slices, so `30 × 3 / 8 ≈ 11` pizzas. Buy 12." You were probably off by a slice or two, and that's fine. What matters is that you didn't buy 2 pizzas or 200.

**Back-of-the-envelope estimation** (the name comes from scribbling on the back of an envelope) is the same thing for systems. You take a few rough facts ("10 million people use the app each day, each makes about 20 requests") and multiply your way to answers like:

- **QPS** (queries per second): how many requests hit the servers every second.
- **Storage**: how many bytes you'll have after a year.
- **Bandwidth**: how many bytes per second flow in and out over the network.
- **Machines**: how many servers, caches or disks that adds up to.

The goal is the right **order of magnitude**, meaning the right power of ten. 12 vs 15 doesn't matter. 12 vs 1,200 matters a lot: that's the difference between "one database is fine" and "we need sharding" (Day 32).

## The numbers to memorize

You only need a handful. Everything else is multiplication.

### Powers of ten and data sizes

| Power | Name | Bytes | Roughly |
|---|---|---|---|
| `10^3` | thousand | 1 KB | a short text message with metadata |
| `10^6` | million | 1 MB | a photo from a phone (compressed), a minute of MP3 |
| `10^9` | billion | 1 GB | an hour of HD video (roughly) |
| `10^12` | trillion | 1 TB | a big laptop disk |
| `10^15` | quadrillion | 1 PB | a thousand of those disks |

Remember Day 2: `2^10 = 1024 ≈ 10^3`. For estimates we treat KB as 1,000 bytes and stop worrying about the 2.4% difference.

### Time

```text
1 day     = 24 × 60 × 60 = 86,400 seconds  ≈ 10^5 seconds (round up to 100,000)
1 month   ≈ 2.5 million seconds            ≈ 2.5 × 10^6
1 year    ≈ 31.5 million seconds           ≈ 3 × 10^7
1 year    = 365 days                       ≈ 400 days if you want easy math (or 365 if you have a calculator)
```

The single most useful trick in this whole lesson:

```text
1 million requests per day  ≈  1,000,000 / 100,000  ≈  10 requests per second
                            (more precisely 11.6 QPS)
```

So **"X million per day" ≈ "10·X per second"**. 100 million/day ≈ 1,000 QPS. 1 billion/day ≈ 10,000 QPS.

### Typical sizes of things

| Thing | Rough size |
|---|---|
| A number (int64), a timestamp | 8 bytes |
| A UUID | 16 bytes (36 as text) |
| A user row (name, email, a few fields) | ~1 KB |
| A tweet-sized post with metadata | ~1 KB (text is small, metadata and indexes add up) |
| A compressed photo | 200 KB – 2 MB |
| A minute of 1080p video | ~50–100 MB raw upload, much less after compression |

### What one machine can do (very rough)

| Component | Ballpark |
|---|---|
| Simple web/API server | 1,000 – 10,000 QPS, depending on how much work each request does |
| A relational database (Day 20) on good hardware | a few thousand to ~10,000+ simple queries/s |
| In-memory cache like Redis | ~100,000+ operations/s per node |
| One server's RAM | 64 – 512 GB is common |
| One server's network card | 10 Gbit/s ≈ 1.25 GB/s |

These vary by 10× depending on the workload. In an interview, say the number out loud and say it's an assumption. That's the skill.

## How it actually works: the recipe

Every estimate follows the same chain:

```text
users  →  actions per user  →  actions per day  →  per second (÷ 10^5)  →  peak (× 2–10)
                                      │
                                      └→ × bytes per action → bytes per day → × 365 → per year
```

1. **Start from users.** Usually **DAU** (daily active users: distinct people who open the app on a given day). If you're given MAU (monthly active users), DAU is often 20–50% of it.
2. **Actions per user per day.** Split reads from writes: people read far more than they write. A 100:1 read:write ratio is common for social apps.
3. **Divide by 100,000** to get average QPS.
4. **Multiply for peak.** Traffic isn't flat: evenings are busier than 4 a.m., and big events spike it. Use 2–3× for a normal daily peak, 10× or more for things like New Year's Eve or a flash sale. You size servers for the **peak**, not the average.
5. **Multiply by size** to get storage and bandwidth.
6. **Add overhead.** Replication (Day 31) usually keeps 3 copies. Indexes and metadata add more. Keep some headroom so disks aren't 100% full.

## Worked example 1: a photo-sharing app

Assumptions (state these out loud):

- 10 million DAU
- Each user uploads 2 photos per day and views 100 photos per day
- Average photo after compression: 500 KB
- Keep photos forever, 3 replicas

**Write QPS**

```text
uploads/day  = 10^7 users × 2       = 2 × 10^7
write QPS    = 2 × 10^7 / 10^5      = 200 per second (average)
peak (×3)    = 600 per second
```

**Read QPS**

```text
views/day    = 10^7 × 100           = 10^9
read QPS     = 10^9 / 10^5          = 10,000 per second
peak (×3)    = 30,000 per second
```

Read:write = 10,000 : 200 = 50 : 1. That's a hint: this system is **read-heavy**, so caching (Day 29) and CDNs (Day 30) will matter a lot.

**Storage**

```text
per day      = 2 × 10^7 photos × 500 KB = 10^7 MB = 10 TB/day
per year     = 10 TB × 365 ≈ 3,650 TB ≈ 3.65 PB
× 3 replicas ≈ 11 PB per year
```

That's far more than one machine can hold, so photos go to object storage (Day 36), and only metadata (who uploaded what, when) lives in a database.

**Metadata**

```text
1 KB per photo row × 2 × 10^7/day = 20 GB/day ≈ 7.3 TB/year
```

Still too big for comfort on one database after a few years: a hint you'll eventually shard (Day 32).

**Bandwidth (outgoing)**

```text
10,000 views/s × 500 KB = 5 × 10^6 KB/s = 5 GB/s
in bits: 5 GB/s × 8 = 40 Gbit/s average, ~120 Gbit/s at peak
```

One server's 10 Gbit/s card can't do that. This is exactly why photos are served from a CDN.

## Worked example 2: how many servers?

Say each API server handles 2,000 QPS comfortably (an assumption). Peak read + write traffic from above is about 30,600 QPS.

```text
servers = 30,600 / 2,000 ≈ 15.3 → 16
add headroom so one data center can fail or a deploy can take some out: ~25–30
```

You'll often see engineers aim to run machines at 50–70% of their max, not 100%, because latency explodes as you approach full utilization (Day 52 explains why with queueing theory).

## A tiny estimator in JavaScript

Writing the chain as code makes the units impossible to mix up:

```js
const DAY = 86_400;            // seconds
const KB = 1e3, MB = 1e6, GB = 1e9, TB = 1e12, PB = 1e15;

function estimate({ dau, writesPerUser, readsPerUser, bytesPerWrite, peak = 3, replicas = 3 }) {
  const writeQps = (dau * writesPerUser) / DAY;
  const readQps = (dau * readsPerUser) / DAY;
  const storagePerYear = dau * writesPerUser * bytesPerWrite * 365 * replicas;
  return {
    writeQps: Math.round(writeQps),
    readQps: Math.round(readQps),
    peakQps: Math.round((writeQps + readQps) * peak),
    storagePerYearPB: +(storagePerYear / PB).toFixed(2),
  };
}

console.log(estimate({ dau: 10e6, writesPerUser: 2, readsPerUser: 100, bytesPerWrite: 500 * KB }));
// { writeQps: 231, readQps: 11574, peakQps: 35417, storagePerYearPB: 10.95 }
```

Notice the exact answer (using 86,400) is about 15% higher than our "÷ 100,000" shortcut. That's fine: same order of magnitude, and the shortcut is something you can do in your head while talking.

## Bits vs bytes (a classic trap)

- Storage is measured in **bytes** (B). Network speed is measured in **bits** per second (b/s).
- 1 byte = 8 bits. A "1 Gbps" link moves at most `1,000,000,000 / 8 = 125 MB/s`.
- Lowercase `b` = bit, uppercase `B` = byte. "100 Mbps home internet" downloads a 1 GB file in about `1,000 MB / 12.5 MB/s = 80 s` at best.

## In an interview

Estimation usually comes right after you've agreed on requirements (Day 55). The interviewer isn't checking your arithmetic precision; they're checking that you:

- **State assumptions** clearly ("I'll assume 100M DAU and that each user posts once a day").
- **Round aggressively** to keep the math easy and talk while you calculate.
- **Separate reads and writes** and notice the ratio.
- **Compute peak**, not just average.
- **Draw a conclusion**: the numbers should change your design. "Write QPS is 200, so one database handles writes; 30k read QPS means we need a cache and replicas."

A good one-paragraph answer sounds like: *"With 10M DAU uploading 2 photos a day, that's 20M uploads a day, which is about 200 writes per second on average and maybe 600 at peak. Reads are 50× that, around 10k per second. At 500 KB each, new photos add 10 TB a day, about 4 PB a year before replication, so photo bytes must live in object storage behind a CDN, and the database only stores metadata."*

## Common mistakes

- **Being too precise.** Saying "11.574 QPS" wastes time. Say "about 12" or even "about 10".
- **Forgetting peak.** Average QPS is not what crashes your servers.
- **Mixing bits and bytes.** Off by 8× instantly.
- **Forgetting replication and indexes.** Real storage is often 3× or more the raw data.
- **Computing numbers and never using them.** Every estimate should end with "...so we need X".
- **Losing track of zeros.** Write in powers of ten (`2 × 10^7`) instead of long strings of zeros.

## Before moving on

- [ ] I can convert "N million requests per day" into QPS in my head
- [ ] I know KB/MB/GB/TB/PB as powers of ten and that 1 day ≈ 10^5 seconds
- [ ] I can estimate a year of storage for a feature, including replicas
- [ ] I can convert bytes/s into Gbit/s and back
- [ ] I can turn an estimate into a design decision

## Go deeper (optional)

- *Designing Data-Intensive Applications* by Martin Kleppmann, chapter 1 (describing load)
- Jeff Dean's "Numbers Everyone Should Know" (see Day 5)
- [Fermi problem on Wikipedia](https://en.wikipedia.org/wiki/Fermi_problem): the same skill, applied to physics
