# CAP and PACELC

> "CAP theorem: pick two of three" is the most quoted and most misquoted idea in system design. Today you'll learn what it really says, why "pick two" is misleading, and the more useful PACELC version interviewers love to hear.

## The big idea

Two friends run a tiny ticket booth together, one at each entrance of a concert hall. They keep a shared count of seats sold by calling each other after every sale. There's one seat left.

Suddenly **the phone line dies** (a network partition). A customer walks up to friend A. A has two choices:

- **Refuse to sell** until the line is back: "Sorry, I can't confirm the count right now." Nobody can ever be double-booked, but customers get turned away. This is choosing **consistency**.
- **Sell anyway** and sort it out later. Customers are served, but friend B might sell the same last seat. This is choosing **availability**.

There is no third option that gives both, because A has **no way to learn** what B did. That's the whole CAP theorem in one story.

## CAP stated correctly

Eric Brewer proposed CAP in 2000; Seth Gilbert and Nancy Lynch proved a formal version in 2002. The three letters have **specific** meanings, narrower than everyday English:

- **C, Consistency**: here it means **linearizability** (Day 40): the system behaves as if there's a single copy of the data, and every read sees the latest completed write. *Not* the "C" in ACID (Day 22), which is about keeping invariants like "balance ≥ 0".
- **A, Availability**: **every** request received by a **non-failing** node gets a **non-error** response. Not "99.99% uptime"; in CAP, if even one healthy node refuses or errors, the system isn't "available".
- **P, Partition tolerance**: the system keeps working even if the network drops or delays any number of messages between nodes.

The theorem: **when a network partition happens, a system must give up either C or A.** It cannot keep both.

### Why "pick two" is misleading

"Pick two of three" suggests you could pick **C + A** and skip P. But partitions aren't a feature you can decline; networks just do it (Day 38). A system that claims "CA" is really saying "we hope the network never partitions", and when it does, it ends up giving up C or A anyway, often unpredictably.

The honest framing is:

```text
Partitions will happen. During one, choose:
  CP: stay consistent → some requests get errors or wait (lose A)
  AP: stay available  → some reads may be stale or writes may conflict (lose C)
When there's no partition, you can have both C and A.
```

A single-node database (one Postgres box) isn't really in this conversation: with one node, there's nobody to disagree with.

## What CP and AP look like

```text
3 replicas, partition separates node 3:

   ┌──────────────────────┐     ✂    ┌──────────┐
   │ node 1      node 2   │          │  node 3  │
   │  (majority side)     │          │ minority │
   └──────────────────────┘          └──────────┘

CP system (e.g. etcd, ZooKeeper, Spanner):
  majority side keeps serving reads and writes
  node 3 refuses writes (and linearizable reads): "no quorum, try later"

AP system (e.g. Cassandra or DynamoDB with eventual reads, DNS):
  all three nodes keep accepting reads and writes
  node 3's clients may read stale data; conflicting writes reconciled after heal
  (last-write-wins, vector clocks or CRDTs, Days 41, 64 and 66)
```

Which is right depends on the **cost of being wrong**:

| Data | Wrong answer costs | Lean |
|---|---|---|
| Bank balance, seat booking, inventory of the last item | money, double booking | CP |
| Leader election, locks, config in etcd | split brain (Day 38) | CP |
| Social media likes count, view counter | a slightly off number | AP |
| Shopping cart (Amazon's Dynamo paper) | an item reappears, user removes it | AP |
| DNS records | a few minutes of an old IP | AP |

Many systems mix both: a store might keep orders and payments CP but product reviews and recommendations AP.

## PACELC: the part CAP leaves out

CAP only talks about the rare moments during a partition. But **most of the time there's no partition**, and there's still a trade-off. Daniel Abadi described it in 2010 as **PACELC**:

```text
if Partition:   choose Availability or Consistency      (P → A / C)
Else:           choose Latency or Consistency           (E → L / C)
```

Why does consistency cost latency even when the network is fine? To guarantee every read sees the latest write, a write must reach other replicas (or a majority of them) **before** you say "done". That's a network round trip, maybe across the planet:

```text
Write in Virginia, replicas in Virginia, Oregon, Ireland (majority = 2 of 3)

Async (EL): ack after local write                    ≈ 1–5 ms
Sync to majority (EC): wait for nearest other region
  Virginia ↔ Oregon round trip                       ≈ 60–70 ms
  → every write is ~15–60× slower
```

Speed-of-light physics (Day 30) means you can't engineer that away. So designers choose:

| System (typical configuration) | Partition: A or C? | Else: L or C? | PACELC |
|---|---|---|---|
| Cassandra, DynamoDB (default eventual reads) | A | L | PA/EL |
| Google Spanner, etcd, ZooKeeper | C | C | PC/EC |
| MongoDB | A (as listed by Abadi) | C | PA/EC, but changes with read/write concern settings |
| Postgres with async read replicas, reads sent to replicas | A for reads | L | reads can be stale, behaves EL |

Treat these labels as **defaults, not identities**. Many modern databases are **tunable**: Cassandra lets each query choose a consistency level (`ONE`, `QUORUM`, `ALL`); DynamoDB offers "strongly consistent reads" at twice the read cost of eventual ones. So the better interview answer is "for *this* data, I'd configure it to favor X".

## A toy simulation

Here's a tiny JavaScript model of two replicas during a partition, so you can see AP and CP behaviour side by side.

```js
function makeCluster(mode) {               // mode: "CP" or "AP"
  const replicas = [{ seats: 1 }, { seats: 1 }];
  let partitioned = false;

  function buy(r) {
    if (mode === "CP" && partitioned) return "error: can't reach peer, try later";
    if (replicas[r].seats === 0) return "sold out";
    replicas[r].seats -= 1;
    if (!partitioned) replicas[1 - r].seats = replicas[r].seats;  // replicate
    return "ticket sold";
  }
  return { buy, split: () => (partitioned = true) };
}

const ap = makeCluster("AP");
ap.split();
console.log(ap.buy(0), "|", ap.buy(1));   // ticket sold | ticket sold  ← sold the last seat twice

const cp = makeCluster("CP");
cp.split();
console.log(cp.buy(0), "|", cp.buy(1));   // error... | error...        ← safe, but nobody served
```

Real CP systems do better than "everyone errors": the side with a **majority** keeps working. That's what quorum-based consensus (Day 42) gives you.

## In an interview

CAP comes up as "Is your design CP or AP?" or "What happens during a network partition?" Interviewers listen for:

- You know partitions are unavoidable, so the real choice is C vs A **during** a partition.
- You define C as linearizability and A as "every non-failing node answers".
- You bring up PACELC: the everyday cost of consistency is **latency**.
- You choose **per data type** based on the business cost of stale or conflicting data.

Good paragraph: "Partitions will happen, so the question is what we sacrifice during one. For seat inventory I'd choose consistency: writes go through a quorum, and the minority side returns errors rather than oversell. For the 'people viewing this event' counter I'd choose availability and accept stale numbers. And even without partitions there's the PACELC trade-off: synchronous cross-region replication would add 60+ ms per booking write, so I'd keep the booking quorum within one region's zones and replicate asynchronously to other regions for reads."

## Common mistakes

- **"We'll pick CA."** You can't opt out of partitions in a distributed system.
- **Confusing CAP's C with ACID's C**, or CAP's A with uptime percentages.
- **Labeling a whole product "AP" or "CP" forever**. Most are tunable per operation.
- **Forgetting the no-partition case**. Latency vs consistency matters every day; partitions are rare.
- **Thinking AP means "anything goes"**. AP systems still converge (eventual consistency) and need a conflict-resolution plan.

## Before moving on

- [ ] I can tell the CAP story with a concrete example
- [ ] I can define C, A and P the way the theorem means them
- [ ] I can explain why "CA" isn't a real option
- [ ] I can explain PACELC and estimate the latency cost of synchronous cross-region writes
- [ ] I can choose CP or AP for a given piece of data and justify it

## Go deeper (optional)

- [Wikipedia: CAP theorem](https://en.wikipedia.org/wiki/CAP_theorem)
- [Wikipedia: PACELC theorem](https://en.wikipedia.org/wiki/PACELC_theorem)
- Eric Brewer, "CAP Twelve Years Later: How the 'Rules' Have Changed", *IEEE Computer*, 2012
- Daniel Abadi, "Consistency Tradeoffs in Modern Distributed Database System Design", *IEEE Computer*, 2012
- *Designing Data-Intensive Applications*, Chapter 9 "Consistency and Consensus"
