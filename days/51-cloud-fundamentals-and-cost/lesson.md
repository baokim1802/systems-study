# Cloud Fundamentals and Cost

> "The cloud" is someone else's data centers, rented by the second. Knowing how it is organized (regions, zones, service levels) and what things actually cost lets you design systems that survive failures and don't bankrupt the company.

## The big idea

Owning servers is like owning a car: you pay up front, you fix it, and it sits idle most of the day. The cloud is like a mix of car rental, taxis and buses:

- **Rent a car** (a virtual machine): you drive, you choose the route, you pay by the hour.
- **Take a taxi** (a managed platform): you say where to go; someone else drives.
- **Hop on a scooter** (serverless): you pay per minute of the ride, nothing while parked.

The trade is always the same: the more someone else handles, the less control you have and (usually) the more you pay per unit of work. But you pay *nothing* for capacity you don't use, and you can get 1,000 servers in minutes.

## How the cloud is organized

```text
 Cloud provider (AWS, Google Cloud, Azure)
 ├── Region: us-east-1 (N. Virginia)      ← a geographic area
 │    ├── Availability Zone us-east-1a    ← one or more data centers,
 │    ├── Availability Zone us-east-1b       own power, cooling, network
 │    └── Availability Zone us-east-1c
 ├── Region: eu-west-1 (Ireland)
 │    └── ... 3+ zones
 └── Edge locations (CDN, Day 30)          ← hundreds of small sites
```

- A **region** is a separate geographic area. Regions are independent: an outage in one should not spread to another. Data stays in a region unless you copy it out (this matters for laws like GDPR).
- An **availability zone (AZ)** is one or more physically separate data centers inside a region, far enough apart that a fire or flood won't hit two, close enough for round trips of about 1–2 ms.
- **Rule of thumb:** run production in at least **two or three AZs**. One data center losing power is normal; a whole region going down is rare but has happened.

| Failure | How often (roughly) | Protection |
|---|---|---|
| One server dies | constantly at scale | multiple instances + load balancer |
| One AZ has trouble | a few times a year industry-wide | spread across 2–3 AZs |
| A whole region degrades | rare, but makes the news | multi-region (expensive) |

## Service models: who manages what

| Model | You manage | Provider manages | Examples |
|---|---|---|---|
| On-premises | everything | nothing | your own racks |
| IaaS (Infrastructure as a Service) | OS, runtime, app, data | hardware, network, virtualization | AWS EC2, Google Compute Engine |
| PaaS (Platform as a Service) | app and data | also OS, runtime, scaling | Heroku, Google App Engine, Elastic Beanstalk |
| Serverless / FaaS (Functions as a Service) | functions and data | everything else, scales to zero | AWS Lambda, Cloud Functions |
| SaaS (Software as a Service) | just your data/settings | the whole app | Gmail, Salesforce |

This split is called the **shared responsibility model**: the provider secures the hardware and data centers; *you* secure your configuration, your code, your access keys, and your data. Most cloud breaches are a misconfigured bucket or a leaked key, not a hacked data center.

### Managed services

Beyond raw machines, clouds rent you "a database" or "a queue" with operations done for you: **managed databases** (Amazon RDS, Cloud SQL), **object storage** (S3, Day 36), **queues** (SQS, Pub/Sub, Day 34), **managed Kubernetes** (EKS, GKE, Day 49), **key-value stores** (DynamoDB).

Managed services handle backups, patches, replication and failover. For a small team that's huge: running a highly available Postgres yourself is a full-time job. The costs: a price premium, less tuning control, and **lock-in** (moving off DynamoDB means rewriting code).

### Serverless in one paragraph

You upload a function; the provider runs it when an event arrives (an HTTP request, a file upload, a queue message) and bills by **requests and compute time** (memory × duration). No traffic, no bill. The catch is the **cold start**: if no warm instance exists, the platform must start one, adding roughly 100 ms to a few seconds to that request depending on the runtime and package size. Functions also have time limits (AWS Lambda: 15 minutes) and keep no state between calls.

## How you pay

| Pricing option | Idea | Typical discount vs on-demand |
|---|---|---|
| On-demand | pay per second/hour, cancel anytime | 0% |
| Reserved / savings plans | commit to 1 or 3 years of usage | up to ~70% |
| Spot / preemptible | spare capacity, can be taken back with ~2 min (AWS) or 30 s (GCP) warning | up to ~90% |

Spot is great for work that can be interrupted and retried: batch jobs, CI runners, video transcoding. Never for your only database.

**The hidden bill is data transfer.** Data coming *in* to the cloud is usually free. Data going *out* to the internet (**egress**) costs money, and so does data crossing AZs and regions.

## The math

Prices change and vary by region; these are approximate AWS us-east-1 list prices, good enough for estimates. Use them as orders of magnitude.

```text
A month ≈ 730 hours
General VM (2 vCPU, 8 GB, e.g. m5.large)  ≈ $0.10/hour  ≈ $70/month
Object storage (S3 Standard)              ≈ $0.023 per GB-month
Egress to the internet                    ≈ $0.09 per GB (cheaper at high volume)
Cross-AZ traffic                          ≈ $0.01 per GB each direction
Cross-region traffic                      ≈ $0.02 per GB
Lambda: $0.20 per million requests + ~$0.0000167 per GB-second
```

### Worked example 1: a small photo app's monthly bill

```text
4 app VMs                 4 × $70                    = $280
Managed Postgres, 2 AZs   (primary + standby)         ≈ $250
Photos: 5 TB stored       5,000 GB × $0.023          = $115
Photos served: 20 TB/mo   20,000 GB × $0.09          = $1,800
                                                     -------
                                                     ≈ $2,445/month
```

Egress is **74%** of the bill. The fix is a CDN (Day 30), which has cheaper per-GB rates and caches popular photos, or compressing images. Always estimate bandwidth, not just servers.

### Worked example 2: serverless vs a VM

One request takes 200 ms with 512 MB of memory:

```text
compute per request = 0.2 s × 0.5 GB = 0.1 GB-s × $0.0000167 = $0.00000167
request fee         = $0.20 / 1,000,000                   = $0.00000020
total               ≈ $0.0000019 per request  ≈ $1.87 per million
```

A $70/month VM that can handle the load costs the same as `70 / 1.87 ≈ 37` million Lambda requests per month, which is about `37,000,000 / 2,628,000 s ≈ 14` requests/second on average.

- Spiky or low traffic (below ~14 req/s average)? Serverless is cheaper and scales to zero.
- Steady high traffic (say 200 req/s ≈ 520 M/month ≈ $970 on Lambda)? The VM wins easily.

The code to check this:

```js
function lambdaMonthly(reqPerSec, seconds, memGB) {
  const reqs = reqPerSec * 730 * 3600;
  const compute = reqs * seconds * memGB * 0.0000166667;
  const requestFees = (reqs / 1e6) * 0.2;
  return Math.round(compute + requestFees);
}
console.log(lambdaMonthly(5, 0.2, 0.5));   // ≈ 25   (VM: $70)
console.log(lambdaMonthly(200, 0.2, 0.5)); // ≈ 981  (VM: $70, maybe two for redundancy)
```

## Going multi-region: worth it?

| | Single region, multi-AZ | Multi-region active-passive | Multi-region active-active |
|---|---|---|---|
| Survives | server and AZ failures | region failure (after a failover) | region failure, almost seamlessly |
| Latency for far users | high (e.g. ~80 ms US↔Europe round trip) | high | low: users hit the nearest region |
| Data | one primary, sync replicas across AZs | async copy to a standby region | conflicts! needs careful design (Days 31, 40) |
| Cost | 1x | ~1.5–2x | ~2x+ plus cross-region transfer |
| Complexity | low | medium | high |

Asynchronous cross-region replication means a failover can lose the last few seconds of writes. Two terms capture this: **RPO** (recovery point objective: how much data you may lose) and **RTO** (recovery time objective: how long until you're back). Multi-AZ gives near-zero RPO cheaply; multi-region is for when an hours-long regional outage is unacceptable, or users are global.

## In an interview

You will rarely be asked "what is IaaS". You *will* be expected to say things like "we deploy across three AZs behind a load balancer", "media goes to object storage and is served through a CDN", "we use a managed queue so we don't operate Kafka ourselves", and to notice when a design's bandwidth bill is enormous.

A good answer to "how would you host this?": "Stateless app servers in an autoscaling group across three availability zones, a managed relational database with a synchronous standby in another AZ, blobs in object storage behind a CDN to cut egress costs and latency. One region to start; we'd add a second region for disaster recovery with async replication once the business can't tolerate a regional outage, accepting a few seconds of RPO."

## Common mistakes

- **"The cloud is always cheaper."** For steady, predictable load at scale, owned or reserved capacity can be far cheaper. The cloud sells flexibility.
- **Forgetting egress.** Bandwidth, not CPU, is often the biggest line item for media-heavy apps.
- **One AZ "for now".** Running in a single data center turns a routine outage into your outage.
- **Multi-region by reflex.** It doubles cost and adds consistency headaches; justify it with requirements.
- **Treating serverless as free scaling.** Cold starts, time limits and per-request pricing at high volume all bite.

## Before moving on

- [ ] I can explain region vs availability zone and why we use multiple AZs
- [ ] I can place IaaS, PaaS, serverless and SaaS on the control vs convenience scale
- [ ] I can estimate a monthly bill and spot that egress dominates
- [ ] I can compute a serverless vs VM break-even
- [ ] I can explain RPO and RTO and when multi-region is worth it

## Go deeper (optional)

- [Cloud computing (Wikipedia)](https://en.wikipedia.org/wiki/Cloud_computing)
- [AWS Well-Architected Framework](https://aws.amazon.com/architecture/well-architected/)
- [AWS Regions and Availability Zones](https://aws.amazon.com/about-aws/global-infrastructure/regions_az/)
