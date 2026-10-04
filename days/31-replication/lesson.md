# Replication

> Replication means keeping copies of the same data on several machines. It's how databases survive crashes and serve more reads, and it's where the strange bugs of distributed systems first show up.

## The big idea

A teacher keeps the official grade book. Two teaching assistants keep copies so students can check their grades without lining up at the teacher's desk. When the teacher changes a grade, she tells the assistants, who update their copies.

This works well, with a few catches:

- If a student asks an assistant **right after** a grade change, the assistant may not have heard yet: the student sees the old grade.
- If the teacher gets sick, one assistant must take over as the official grade book. Which one? What if she missed the last few updates?
- What if two teachers both made changes to the same grade at the same time in different rooms?

That's replication. A **replica** is a machine holding a copy of the data. Replication buys you three things:

1. **Durability and availability**: if one machine dies, others still have the data and can keep serving.
2. **Read scaling**: spread reads across many copies (Day 27's "read replicas").
3. **Lower latency**: put a copy near users in another region.

The hard part is the one thing every replication scheme must solve: **how do changes get to every copy, and what do readers see in the meantime?** There are three main designs.

## 1. Leader–follower (single leader)

One replica is the **leader** (also called primary or master). **All writes go to the leader.** The leader records each change in its log (remember the write-ahead log from Day 22) and streams that log to the **followers** (replicas, secondaries), which apply the same changes in the same order. Reads can go to the leader or any follower.

```text
              writes
 clients ───────────────► [ LEADER ] ── replication log ──┬──► [ follower 1 ]
    │                                                      └──► [ follower 2 ]
    └────── reads ───────────► any of them
```

This is how PostgreSQL, MySQL, MongoDB (replica sets) and most relational databases replicate by default. It's simple because there's exactly one place where the order of writes is decided, so there are no write conflicts.

## Synchronous vs asynchronous

When a client writes to the leader, when does the leader say "OK, done"?

- **Synchronous**: the leader waits until a follower confirms it has the change. If the leader then dies, the follower is guaranteed to have the write. Cost: every write is slower (at least one extra network round trip), and if the synchronous follower is down or slow, writes block.
- **Asynchronous**: the leader confirms as soon as the write is on its own disk and sends it to followers in the background. Fast, and followers can fall behind without blocking anything. Cost: if the leader dies, writes it confirmed but hadn't sent yet are **lost**.
- **Semi-synchronous**: a common middle ground. Wait for **one** follower (synchronous), and update the rest asynchronously. You always have at least two copies of every confirmed write.

```text
write timeline (async):
  t=0   client → leader: "set balance = 50"
  t=1   leader writes to its disk, replies "OK" to client
  t=2   leader CRASHES before sending the change to followers
  t=3   follower is promoted; balance is still the old value → the confirmed write is gone
```

## Replication lag and its strange effects

With asynchronous replication, followers are usually behind the leader by some milliseconds, but under heavy load or after a network hiccup the **replication lag** can reach seconds or minutes. Reading from a lagging follower causes surprising bugs. Three classic ones (from *Designing Data-Intensive Applications*):

**Reading your own writes.** You update your profile name, the page reloads, and the read goes to a follower that hasn't got the change: your old name is back. You think the save failed.
Fix: **read-your-writes consistency**. For example, read a user's own data from the leader for a short time after they write it, or remember the log position of their last write and only read from a follower that has caught up to it.

**Monotonic reads (time going backwards).** You refresh a comment thread twice. The first read hits a follower that's up to date and shows a new comment; the second hits a lagging follower and the comment disappears.
Fix: send each user's reads to the **same** replica (e.g. choose the replica by hashing the user ID).

**Consistent prefix reads.** Mary asks "How's the weather?" and John replies "Sunny!". A reader whose replicas apply these out of order sees John's answer *before* Mary's question.
Fix: make sure causally related writes are applied in order (easy with one leader, harder when data is split across partitions).

These anomalies are why later days spend so much time on **consistency models** (Day 40).

### A tiny simulation in JavaScript

```js
const leader = { data: {}, log: [] };
const follower = { data: {}, applied: 0 };

function write(key, value) {
  leader.data[key] = value;
  leader.log.push({ key, value });
}
function replicate(maxEntries) { // the follower catches up a little at a time
  while (follower.applied < leader.log.length && maxEntries-- > 0) {
    const { key, value } = leader.log[follower.applied++];
    follower.data[key] = value;
  }
}

write('name', 'Kim');
replicate(10);
write('name', 'Kim Tran');           // user renames themselves
console.log(follower.data.name);     // 'Kim'  ← stale read: lag of 1 entry
console.log(leader.log.length - follower.applied); // replication lag = 1
replicate(10);
console.log(follower.data.name);     // 'Kim Tran'
```

Real databases do exactly this, measuring lag in bytes of log or seconds.

## Failover: when the leader dies

Followers dying is easy: when one comes back, it asks the leader for the log from where it left off and catches up. The leader dying is harder. **Failover** means:

1. **Detect** that the leader is dead. Usually by timeout: no heartbeat for, say, 10–30 seconds. Too short and you fail over during a brief hiccup; too long and you're down longer.
2. **Choose a new leader**, ideally the follower with the most up-to-date data. This is a consensus problem (Day 42); tools like Patroni (PostgreSQL) use etcd or ZooKeeper to make the choice safely.
3. **Reconfigure**: clients and the other followers must start using the new leader, and the old leader must not come back thinking it's still in charge.

What can go wrong:

- **Lost writes**: with async replication, the new leader may be missing the old leader's last writes. If the old leader rejoins, its extra writes are typically thrown away. GitHub had a well-known incident in 2012 where a promoted MySQL follower was behind, and reused auto-increment IDs that already existed in Redis, leaking some private data between users.
- **Split brain**: the old leader wasn't really dead, just slow or cut off by the network. Now **two** nodes accept writes, and the data diverges. Systems prevent this with **fencing**: the new leader gets a higher "epoch" or "term" number, and storage rejects writes from older epochs (Day 38 and Day 42 go deeper).

## 2. Multi-leader replication

Several nodes accept writes, each replicating to the others. Common when you have **data centers in several regions**: each region has a leader, so writes are local and fast, and a region can keep working if the link between regions breaks. Collaborative and offline-first apps (Day 64) are a similar case: each device is effectively a leader.

The big new problem: **write conflicts**. Two users edit the same document title at the same moment in different regions. Both leaders accept the write; when they sync, which wins?

- **Last write wins (LWW)**: keep the write with the latest timestamp. Simple, but silently drops the other write, and clocks lie (Day 41).
- **Merge**: combine the values (e.g. union of two shopping-cart edits), or use data types designed to merge automatically (**CRDTs**, Day 64).
- **Ask the user / application** to resolve, like a git merge conflict.

Many teams avoid multi-leader unless they really need it, or route all writes for a given record to one "home" region to avoid conflicts.

## 3. Leaderless replication

There's no leader at all. The client (or a coordinator node) sends each write to **several replicas** at once and each read to several replicas too. Amazon's Dynamo design made this popular; Cassandra and Riak work this way.

With `N` replicas, a write must be confirmed by `W` of them and a read must ask `R` of them. If `R + W > N`, every read overlaps at least one replica that has the latest write:

```text
N = 3, W = 2, R = 2   →   2 + 2 = 4 > 3   → read and write sets always share a replica

replicas:  [A] [B] [C]
write hits:  A   B          (W = 2)
read asks:       B   C      (R = 2)  → B has the new value; use the newest version
```

Replicas that missed writes are repaired later: **read repair** fixes stale replicas noticed during a read, and an **anti-entropy** background process compares replicas (using Merkle trees, Day 66). This "quorum" idea is covered properly in Day 40.

## Comparison

| | Single leader | Multi-leader | Leaderless |
|---|---|---|---|
| Who accepts writes | One leader | One leader per region/device | Any replica (quorum) |
| Write conflicts | None | Yes, must resolve | Yes, must resolve |
| Failover | Needed, can be tricky | Other leaders keep working | Not needed: no leader |
| Typical systems | PostgreSQL, MySQL, MongoDB | Multi-region setups, CouchDB, offline apps | Cassandra, Riak, DynamoDB-style |
| Best for | Most applications | Multi-region writes, offline clients | High write availability, tolerating node failures |

## The math: how many copies?

If each machine independently has a 1% chance of being down at a given moment:

```text
1 copy:  data unavailable 1% of the time
2 copies: both down = 0.01 × 0.01 = 0.0001 = 0.01%
3 copies: 0.01^3 = 0.000001 = 0.0001%
```

That's why **3 replicas** is such a common default. (Real failures aren't fully independent, which is why replicas go in different racks and availability zones. Day 45 does this math properly.)

## In an interview

You'll say "the database is replicated" in nearly every design. Interviewers want to hear:

- **Which model**: single leader for most things; leaderless or multi-leader with a reason.
- **Sync vs async**, and what that means for losing writes on failover.
- **Replication lag** and which user-visible anomaly it could cause, plus a fix (read-your-writes from the leader, sticky replica per user).
- **Failover** and how you avoid split brain.

Sample answer: *"PostgreSQL with one leader and two followers in different availability zones, one synchronous so a confirmed write survives a leader crash, one async for reads. Reads that must reflect the user's own recent changes go to the leader; everything else goes to followers. Failover is automated with Patroni and etcd, which elect one leader and fence the old one so we can't get split brain."*

## Common mistakes

- **Treating replication as a backup.** A bad `DELETE` replicates instantly to every copy. You still need backups and point-in-time recovery.
- **Reading from followers for everything** and getting read-your-writes bugs.
- **Assuming async failover loses nothing.** It can lose the last confirmed writes.
- **Thinking replication scales writes.** With a single leader every write still goes through one node. Scaling writes needs sharding (Day 32).
- **Using last-write-wins without realizing it drops data.**

## Before moving on

- [ ] I can explain single-leader, multi-leader and leaderless replication
- [ ] I can explain sync vs async replication and the trade-off
- [ ] I can describe read-your-writes and monotonic-reads problems and fix them
- [ ] I can walk through a failover and explain split brain
- [ ] I can check whether `R + W > N` for a given setup

## Go deeper (optional)

- *Designing Data-Intensive Applications*, chapter 5 ("Replication")
- [Replication (computing) on Wikipedia](https://en.wikipedia.org/wiki/Replication_(computing))
- [PostgreSQL documentation: High Availability, Load Balancing, and Replication](https://www.postgresql.org/docs/current/high-availability.html)
- DeCandia et al., "Dynamo: Amazon's Highly Available Key-value Store" (2007)
