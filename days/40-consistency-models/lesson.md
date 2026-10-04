# Consistency Models

> When data has copies on several machines, "what will a read return?" stops having an obvious answer. Consistency models are the precise menu of promises a system can make, from "exactly like one machine" down to "it'll all agree eventually".

## The big idea

You change your profile photo, hit refresh, and **the old photo is back**. Refresh again: new photo. Again: old. Nothing is broken. Your write went to one replica (a copy of the data, Day 31), and your reads are bouncing between replicas that have and haven't received it yet.

Whether that's acceptable depends on what the system **promised**. A **consistency model** is that promise: a contract between the storage system and the programmer about which values a read is allowed to return, given the writes that have happened.

Think of it like news reaching a group of friends:

- **Linearizable**: there's one whiteboard in the middle of the room. The moment anyone writes on it, everyone who looks sees it.
- **Causal**: news travels by word of mouth, but nobody ever hears a *reply* before hearing the *question* it answers.
- **Eventual**: news travels by postcards. Everyone will know eventually, but for now some friends have heard and some haven't, in any order.

Stronger promises are easier to program against. Weaker ones are faster and stay available during partitions (Day 39).

## The models, strongest to weakest

### Linearizability (strong consistency)

The system behaves as if there's **a single copy** of the data, and each operation takes effect instantly at some point between when it starts and when it finishes. Once a write completes, **every** later read (by anyone, anywhere) sees it or something newer. Once any reader has seen the new value, no reader can see the old one again.

```text
time ─────────────────────────────────────────────▶
Alice: write x=1 [────────]
Bob:                          read x [──] → must return 1
Carol:       read x [──────────] → 0 or 1 (overlaps the write)
             if Carol got 1, Bob must also get 1 (no going back)
```

Needed for: locks, leader election, unique usernames, "don't sell the last seat twice". Costs a round trip to a quorum or leader (Day 39's PACELC latency). Systems: etcd, ZooKeeper (for writes), Spanner.

### Sequential consistency

All operations appear in **some single order** that every client agrees on, and each client's own operations appear in the order it issued them. But that order **doesn't have to match real time**: a read may return a value that's a bit old, as long as everyone sees the same history.

### Causal consistency

Operations that are **causally related** (one could have influenced the other) are seen by everyone in the same order. Unrelated (**concurrent**) operations may be seen in different orders by different people.

```text
Alice posts:  "Anyone want pizza?"          (A)
Bob replies:  "Yes! Pepperoni."             (B, written after reading A → A causes B)
Carol posts:  "Nice weather today"           (C, unrelated to A and B)

Causal consistency guarantees: nobody sees B without A.
It does NOT guarantee everyone sees C before or after A.
```

Without it, a user could see Bob's "Yes! Pepperoni." with nothing above it. Causal consistency is the strongest model that can stay available during partitions, which makes it attractive. Day 41's vector clocks are how systems track "what caused what".

### Session guarantees (per-user promises)

Often you don't need global guarantees, just sanity for one user:

- **Read-your-writes**: after *you* write something, *your* reads see it. (Fixes the profile-photo bug.)
- **Monotonic reads**: once you've seen a value, you never see an older one later. (No going "back in time" on refresh.)
- **Monotonic writes**: your writes are applied in the order you made them.
- **Consistent prefix**: you see writes in an order that makes sense (questions before answers).

Common ways to get them:

- Route a user's reads to the **leader** for a short time (say 10 s) after they write.
- **Sticky sessions**: always send a user to the same replica.
- Have the client remember the **version or timestamp** of its last write; a replica serves the read only if it has caught up to at least that version.

### Eventual consistency

If writes stop, all replicas will **eventually** converge to the same value. That's it. No promise about *when*, and no promise about what you read in the meantime. DNS (Day 13), CDN caches (Day 30) and async replicas are eventually consistent. It's the weakest useful model, and the cheapest and most available.

| Model | Promise | Available in partition? | Typical use |
|---|---|---|---|
| Linearizable | acts like one copy, real-time order | no | locks, unique IDs, inventory |
| Sequential | one agreed order, per-client order kept | no | rarely used directly in DBs |
| Causal | cause before effect everywhere | yes | comments, chat, social feeds |
| Read-your-writes etc. | sane view for one session | mostly | profile edits, settings |
| Eventual | converges when writes stop | yes | counters, DNS, caches |

## Quorums: tuning consistency with numbers

**Leaderless** databases like Cassandra and DynamoDB-style stores (inspired by Amazon's Dynamo paper) write to and read from several replicas directly, with three knobs:

- **N** = number of replicas holding each key
- **W** = replicas that must confirm a write before it's "successful"
- **R** = replicas asked on each read (the reader takes the value with the newest version)

The rule: **if `R + W > N`, every read set overlaps every write set in at least one replica**, so a read always contacts at least one replica that has the latest successful write.

```text
N = 3, W = 2, R = 2:  2 + 2 = 4 > 3 ✓

replicas:      [A]  [B]  [C]
write x=v2:     ✓    ✓        ← W=2 confirmed; C still has v1
read asks:           ✓    ✓   ← R=2: B has v2, C has v1 → pick newest → v2
any 2 of 3 must include A or B: the sets can't avoid each other
```

Here's that idea as a tiny simulation:

```js
const N = 3;
const replicas = Array.from({ length: N }, () => ({ version: 0, value: null }));

function pick(k) {                                 // k random distinct replicas
  return [...replicas.keys()].sort(() => Math.random() - 0.5).slice(0, k);
}
function write(value, version, W) {
  for (const i of pick(W)) replicas[i] = { version, value };
}
function read(R) {
  return pick(R).map(i => replicas[i])
    .reduce((best, r) => (r.version > best.version ? r : best));
}

write("blue", 1, 2);           // W = 2
console.log(read(2).value);    // R = 2 → always "blue"   (2 + 2 > 3)
console.log(read(1).value);    // R = 1 → null 1 time in 3 (stale)
```

### Choosing N, R, W

| Setting (N=3) | R + W > N? | Good for | Survives |
|---|---|---|---|
| W=2, R=2 | 4 > 3 ✓ | balanced, the usual default | 1 node down for reads and writes |
| W=3, R=1 | 4 > 3 ✓ | read-heavy, fast reads | reads survive 2 down; **writes fail if any node is down** |
| W=1, R=3 | 4 > 3 ✓ | write-heavy | writes survive 2 down; reads fail if any node is down |
| W=1, R=1 | 2 < 3 ✗ | lowest latency, eventual only | most failures, but reads can be stale |

General rule: writes tolerate `N − W` failed nodes, reads tolerate `N − R`.

Important caveat: `R + W > N` makes stale reads much less likely, but on its own it is **not** full linearizability. Concurrent writes, a write that succeeded on fewer than W nodes before failing, and "sloppy quorums" (writing to stand-in nodes during failures) can all still produce surprises. Real systems add **read repair** (fix stale replicas a read notices) and **anti-entropy** (background syncing with Merkle trees, Day 66).

## The math

```text
N = 5. Want reads and writes to overlap AND tolerate 2 node failures for both.
  tolerate 2 failed for writes → W ≤ 3
  tolerate 2 failed for reads  → R ≤ 3
  overlap → R + W > 5 → R + W ≥ 6 → W = 3, R = 3 ✓   (majority quorums)

Chance a single-replica read (R=1, N=3) is stale right after a W=1 write,
before replication catches up: 2 of 3 replicas lack it → 2/3 ≈ 67%
With W=2: 1 of 3 lacks it → 1/3 ≈ 33%
```

## In an interview

Interviewers ask "what consistency does this need?" for each piece of data, and probe quorums in key-value store designs (Day 66). They listen for:

- Precise names: linearizable vs eventual vs read-your-writes, not just "strong" vs "weak".
- Matching the model to the feature: often the cheapest model that doesn't confuse users.
- Quorum math with the overlap argument, and the availability cost of high R or W.

Good paragraph: "Usernames need linearizability, so registration goes through a single leader with a unique constraint. Posts and comments only need causal consistency so replies never appear before their parent, and each user gets read-your-writes by reading from the leader for a few seconds after they post. Like counts can be eventually consistent. In the leaderless store I'd use N=3, W=2, R=2: reads and writes overlap, and either survives one node down."

## Common mistakes

- **Saying "strong consistency" without saying what it means**. Name the model.
- **Assuming `R + W > N` equals linearizability**. It's overlap, not a full guarantee.
- **Setting W = N for safety** and then losing write availability when one node is down.
- **Using eventual consistency where users notice**: posting a comment and not seeing it feels like a bug. Add read-your-writes.
- **Mixing up sequential and linearizable**: only linearizable respects real-time order.

## Before moving on

- [ ] I can explain linearizable, causal and eventual consistency with examples
- [ ] I can name the four session guarantees and one technique for read-your-writes
- [ ] I can explain why `R + W > N` makes reads see the latest write
- [ ] I can choose N, R, W for a read-heavy vs a write-heavy workload and state the failures tolerated
- [ ] I can say which features in an app need which model

## Go deeper (optional)

- *Designing Data-Intensive Applications*, Chapter 5 (replication lag, quorums) and Chapter 9 (linearizability, causality)
- [Wikipedia: Consistency model](https://en.wikipedia.org/wiki/Consistency_model)
- [Wikipedia: Linearizability](https://en.wikipedia.org/wiki/Linearizability)
- [Jepsen: Consistency Models](https://jepsen.io/consistency)
- DeCandia et al., "Dynamo: Amazon's Highly Available Key-value Store", SOSP 2007
