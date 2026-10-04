# Consensus and Leader Election

> Replication (Day 31) copies data to many machines, but someone has to decide *which* writes happened and in *what order* — even while machines crash and messages get lost. Consensus is how a group of computers agrees on one answer anyway, and it quietly powers Kubernetes, Kafka, and most databases you'll ever use.

## The big idea

Five friends are planning dinner over a flaky group chat. Some messages arrive late, some never arrive, and one friend's phone dies halfway through. They still need to end up with **one** restaurant that everybody agrees on — not two groups showing up at two different places.

A sensible rule: *"Whatever a majority (3 of 5) agrees on is final."* Any two majorities of 5 people always share at least one person, so two conflicting decisions can never both get a majority. That overlapping person is the "witness" who stops the group from splitting.

That's the heart of **consensus**: a group of machines (called **nodes**) agreeing on a value — or, more usefully, on a *sequence* of values — so that:

- **Agreement:** no two nodes decide different things.
- **Validity:** the decided value was actually proposed by someone (no making things up).
- **Termination:** every node that doesn't crash eventually decides.

And it must hold even when some nodes crash and the network delays or drops messages.

## Why not just "one boss"?

The simplest design is a single **leader** that decides everything and tells the others. That works great — until the leader dies. Then:

- Who becomes the new leader? Everyone must agree on that too (that's consensus again).
- What if the old leader wasn't dead, just slow (Day 38: you can't tell the difference)? Now you have two leaders — **split brain** — both accepting writes.

So real systems use a leader for speed, *plus* a consensus protocol to elect the leader safely and to make sure a write only "counts" once a majority has it.

A famous result, the **FLP impossibility** (Fischer, Lynch, Paterson, 1985), says no deterministic algorithm can *guarantee* reaching consensus in a fully asynchronous network if even one node may crash. Practical protocols dodge this by using timeouts and randomness: they are always **safe** (never disagree) and are *live* (make progress) whenever the network behaves reasonably for a while.

## Quorums: the magic of majorities

A **quorum** is the minimum number of nodes that must agree before something counts. Consensus protocols use a **majority quorum**: `floor(n/2) + 1`.

| Cluster size `n` | Majority quorum | Failures tolerated |
|---|---|---|
| 1 | 1 | 0 |
| 2 | 2 | 0 |
| 3 | 2 | 1 |
| 4 | 3 | 1 |
| 5 | 3 | 2 |
| 7 | 4 | 3 |

General rule: a cluster of `n = 2f + 1` nodes survives `f` failures. Notice that 4 nodes tolerate no more failures than 3 — you pay for an extra machine and get *more* nodes that must agree. That's why consensus clusters are almost always **3 or 5** nodes (sometimes 7). Bigger isn't better: every write must wait for a majority, so more nodes means more messages and a slower "slowest of the majority".

Why majorities and not, say, "any 2 nodes"? Because **any two majorities overlap**. If a value was accepted by 3 of 5 nodes, any future group of 3 contains at least one node that saw it. This is the same overlap trick as `R + W > N` from Day 40.

## Raft, step by step

**Raft** (Ongaro and Ousterhout, 2014) was designed to be *understandable*, unlike its famously tricky ancestor **Paxos** (Lamport). It is used in etcd, Consul, CockroachDB, TiKV, and Kafka's newer KRaft mode. Raft splits consensus into three pieces: leader election, log replication, and safety.

### Roles and terms

Every node is in one of three states:

```text
            times out,             receives votes
            starts election        from majority
 Follower ─────────────────▶ Candidate ─────────────▶ Leader
    ▲                            │                      │
    │   discovers current leader │                      │
    └────────────────────────────┘                      │
    ▲          discovers a higher term                  │
    └───────────────────────────────────────────────────┘
```

Time is divided into **terms**, numbered 1, 2, 3, … Think of a term as a "reign": each term has at most one leader. Every message carries the sender's term. If a node sees a higher term than its own, it immediately updates its term and steps down to follower. Terms act as a **logical clock** (Day 41) that lets nodes detect stale leaders.

### Leader election

1. The leader sends regular **heartbeats** (empty "append entries" messages), e.g. every 50 ms.
2. Each follower has an **election timeout**, chosen *randomly* between e.g. 150 and 300 ms. If it hears nothing from a leader for that long, it assumes the leader is dead.
3. It becomes a **candidate**: increments its term, votes for itself, and sends `RequestVote` to everyone.
4. Each node grants **at most one vote per term**, first come first served — and only if the candidate's log is at least as up-to-date as its own (compare the term of the last entry, then the length).
5. A candidate with votes from a majority becomes **leader** and starts sending heartbeats.
6. If nobody wins (a **split vote**), the term times out and a new election starts with a new random timeout.

Why random timeouts? If all followers timed out at the exact same moment, they'd all become candidates, all vote for themselves, and nobody would ever win. Randomness makes it likely that one node times out first and collects votes before the others even wake up.

### Log replication

Raft agrees on a **log**: an ordered list of commands like `set x = 5`. Every node applies the same commands in the same order, so they all end up in the same state. This is called a **replicated state machine**.

```text
 Client: "set x = 5"
    │
    ▼
 Leader (term 3) appends entry #7 to its log
    │  AppendEntries(#7) ──▶ Follower A  ✓ stored
    │  AppendEntries(#7) ──▶ Follower B  ✓ stored
    │  AppendEntries(#7) ──▶ Follower C  (slow…)
    │  AppendEntries(#7) ──▶ Follower D  (down)
    ▼
 Leader + A + B = 3 of 5 → entry #7 is COMMITTED
 Leader applies it, replies "OK" to client, and tells followers
 the new commit index in the next heartbeat.
```

An entry is **committed** once a majority stores it. Committed entries are never lost: any future leader must win a majority vote, at least one voter has the entry, and the "up-to-date log" voting rule means a candidate missing a committed entry can't win.

If a follower's log disagrees with the leader's (say, it holds leftovers from an old leader that never committed), the leader walks back to the last matching entry and overwrites the follower's tail. The leader's log is the source of truth.

### Computing the commit index (a small piece of Raft in JS)

The leader tracks `matchIndex`: the highest log index known to be stored on each node (including itself). The commit index is the largest index stored on a majority:

```js
// matchIndex: highest replicated log index per node, leader included
function commitIndex(matchIndex) {
  const sorted = [...matchIndex].sort((a, b) => b - a); // descending
  const majority = Math.floor(matchIndex.length / 2) + 1;
  return sorted[majority - 1]; // the majority-th highest value
}

console.log(commitIndex([10, 9, 7, 4, 2])); // 7 → nodes with 10, 9, 7 all have #7
console.log(commitIndex([10, 10, 3]));      // 10
```

(Real Raft adds one more rule: a leader only commits by counting replicas for entries *from its own current term*. Older entries become committed indirectly. This closes a subtle hole described in the paper's Figure 8.)

## Leases, fencing, and the "zombie leader"

A partitioned old leader might not know it's been replaced. In Raft it can't *commit* anything (it can't reach a majority), but if your app uses "I am leader" to do side effects — send emails, write to S3 — it could still cause harm.

Two standard defenses:

- **Leases:** leadership is valid only for a fixed time (e.g. 10 s) and must be renewed. If the leader can't renew, it stops acting *before* the lease expires (allowing for clock drift, Day 41).
- **Fencing tokens:** every time a new leader is elected, it gets a strictly larger number (Raft's term works). The storage system rejects any write carrying a token smaller than one it has already seen. A zombie with token 33 is rejected once someone has written with 34.

## ZooKeeper and etcd: consensus as a service

You almost never implement Raft yourself. Instead you use a small, highly reliable **coordination service** that runs consensus for you, and you store tiny, critical facts in it: who's leader, which config is current, which shard lives where.

| | ZooKeeper | etcd |
|---|---|---|
| Protocol | Zab (Paxos-like) | Raft |
| Data model | Tree of "znodes" | Flat key–value with revisions |
| Leader election recipe | Ephemeral sequential znodes; lowest number wins | Leases + compare-and-swap on a key |
| Used by | Older Kafka, HBase, Hadoop | Kubernetes (all cluster state) |

A typical leader-election recipe in ZooKeeper: each candidate creates an **ephemeral** node (deleted automatically when its session dies) with a sequence number, like `/election/n_0000000017`. The lowest number is leader. Everyone else watches the node just before theirs, so when the leader dies only one node gets woken up.

These services are built for **small data and low write rates** (etcd's default storage limit is 2 GB). Don't use them as your main database.

## The math

**How likely is the cluster to lose quorum?** Suppose each node is independently down 1% of the time (`p = 0.01`).

```text
3 nodes: lose quorum if ≥ 2 are down
  P = C(3,2)·p²·(1-p) + p³
    = 3 · 0.0001 · 0.99 + 0.000001
    ≈ 0.000298            → about 0.03% of the time

5 nodes: lose quorum if ≥ 3 are down
  P ≈ C(5,3)·p³ = 10 · 0.000001 = 0.00001 → about 0.001%
```

Going from 3 to 5 nodes makes losing quorum roughly 30 times rarer. Real failures are often correlated (same rack, same bad deploy), which is why nodes are spread across availability zones.

**Write latency:** a commit needs one round trip from the leader to the *fastest majority* plus a disk `fsync` on each. Within one data center (round trip ~0.5 ms, SSD fsync ~1 ms) that's a few ms. Across continents (round trip ~100 ms) every write costs at least ~100 ms, which is why global consensus is expensive.

## In an interview

Consensus shows up whenever you say "leader": *"How do you pick the leader? What if it dies? What if two nodes both think they're leader?"* Interviewers want to hear **majority quorums**, **terms/epochs**, **fencing**, and that you'd use etcd or ZooKeeper rather than invent your own.

A good answer: *"I'd run a 3- or 5-node Raft group, for example etcd, across three availability zones. A leader is elected by majority vote; each election bumps a term number, and a node seeing a higher term steps down. Writes are committed once a majority has them, so a 5-node cluster survives 2 failures and a minority partition can't make progress, which prevents split brain. For side effects outside the cluster I'd pass the term as a fencing token so a stale leader's writes are rejected."*

## Common mistakes

- **"More nodes = more fault tolerance, always."** 4 nodes tolerate 1 failure, same as 3. Use odd numbers.
- **"The minority side keeps serving writes during a partition."** In Raft it can't commit; it becomes unavailable for writes. That's the CP choice from Day 39.
- **"Leader election means only one node *thinks* it's leader."** Two nodes can briefly both believe it. Safety comes from quorums and fencing, not from beliefs.
- **"Consensus makes a system fast."** It makes it *correct*. Every write pays at least one majority round trip.
- **Storing big data in ZooKeeper/etcd.** They're for small coordination data, not your users table.

## Before moving on

- [ ] I can state the consensus problem (agreement, validity, termination) in plain words
- [ ] I can explain why majorities overlap and why clusters are 3 or 5 nodes
- [ ] I can walk through a Raft election, including why timeouts are random
- [ ] I can explain when a log entry is committed
- [ ] I can explain fencing tokens and why a zombie leader is dangerous
- [ ] I know what etcd and ZooKeeper are used for

## Go deeper (optional)

- [The Raft paper: In Search of an Understandable Consensus Algorithm](https://raft.github.io/raft.pdf)
- [raft.github.io](https://raft.github.io/) — includes an interactive visualization of elections
- [Wikipedia: Paxos](https://en.wikipedia.org/wiki/Paxos_%28computer_science%29)
- *Designing Data-Intensive Applications*, chapter 9 ("Consistency and Consensus")
