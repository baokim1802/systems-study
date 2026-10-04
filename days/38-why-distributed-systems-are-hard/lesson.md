# Why Distributed Systems Are Hard

> As soon as your program runs on more than one machine, things can half-break: a message vanishes, a server freezes for ten seconds, two machines both believe they're in charge. Today is about why that happens and the mindset that keeps you safe.

## The big idea

You text a friend: "Meet at 7?" No reply. What happened?

- Your message never arrived.
- It arrived, but their phone is dead.
- They read it and replied, but **the reply** got lost.
- They're typing slowly and the reply comes in an hour.

From your side, **all four look exactly the same**: silence. You can't tell "they didn't get it" from "they got it and I didn't hear back". That's the core problem of distributed systems. A **distributed system** is any system where separate computers cooperate by sending messages over a network, and the only way one machine learns anything about another is through messages that can be lost, delayed or duplicated.

On a single computer, failures are mostly **total**: the program crashes, everything stops, you restart. In a distributed system, failures are **partial**: some parts work, some don't, and the parts that work often can't tell which is which.

## Partial failure in practice

Your checkout service calls the payment service and waits:

```text
checkout ──── "charge $40" ────▶ payment
checkout ◀────── ???? ─────────  payment
```

After 5 seconds with no answer, did the charge happen? Possibilities:

1. The request was lost before payment saw it. **Not charged.**
2. Payment crashed mid-processing. **Maybe charged.**
3. Payment charged the card, but the response was lost. **Charged.**
4. Payment is just slow (a GC pause, Day 10, or an overloaded disk). **Will be charged, soon.**

If you retry, you might charge twice (cases 3 and 4). If you don't, you might never charge (case 1). There's no way to know from the checkout side alone. The fix isn't a smarter timeout; it's designing operations so retrying is safe (**idempotency**, Day 43).

## The eight fallacies of distributed computing

In the 1990s, engineers at Sun Microsystems (L. Peter Deutsch and colleagues) listed assumptions newcomers make that are false:

| Fallacy | Reality |
|---|---|
| 1. The network is reliable | Packets drop, cables get cut, switches reboot |
| 2. Latency is zero | Same data center ≈ 0.5 ms round trip; across an ocean ≈ 100+ ms (Day 5) |
| 3. Bandwidth is infinite | Links saturate; big payloads queue behind each other |
| 4. The network is secure | Assume anyone can listen or tamper (Day 15) |
| 5. Topology doesn't change | Servers come and go; IPs change; autoscaling |
| 6. There is one administrator | Many teams, vendors and clouds, each with their own config |
| 7. Transport cost is zero | Serialization costs CPU; cross-region traffic costs money |
| 8. The network is homogeneous | Mixed hardware, OSes, protocol versions |

Every one of these has caused real outages. Fallacies 1 and 2 are the ones that bite in almost every design.

## Unreliable networks and timeouts

Most networks in data centers are **asynchronous**: there's no upper bound on how long a message can take. TCP (Day 12) retransmits lost packets, but that only converts "lost" into "late", and from the outside "very late" looks the same as "lost".

So you use a **timeout**: "if no reply in T, assume failure". Choosing T is a trade-off:

- **Too short**: you declare healthy-but-slow nodes dead, retry needlessly, and pile extra load onto an already-struggling system. This can cause **cascading failure**.
- **Too long**: users wait, and your threads, connections and memory are tied up by requests that will never come back.

A common rule of thumb: set the timeout a bit above the downstream's normal **p99 latency** (the time 99% of requests finish within, Day 46), and keep the total budget below what the user will tolerate.

```js
// A fetch with a timeout. If it fires, we know nothing about whether the server acted.
async function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
```

Note the comment: a timeout tells you about *your* waiting, not about *their* work.

## Network partitions

A **network partition** is when the network splits machines into groups that can't talk to each other, while each group keeps running:

```text
   Data center A                 Data center B
 ┌──────────────┐    ✂ link    ┌──────────────┐
 │ node1  node2 │   broken     │ node3  node4 │
 └──────────────┘              └──────────────┘
 both sides are alive; each thinks the other side is dead
```

Partitions aren't hypothetical. Studies of production networks (for example the paper "The Network Is Reliable" by Bailis and Kingsbury, 2014) collected many real cases: misconfigured switches, faulty NICs that could send but not receive, and long GC pauses that looked like partitions to everyone else.

During a partition, every system must choose: keep serving on both sides and risk them disagreeing, or stop serving on one side to stay consistent. That's the CAP choice, tomorrow's topic (Day 39).

## Split brain

The scariest partition outcome. You have a **leader** (the one node allowed to accept writes, Day 31) and a follower. The network between them breaks. The follower sees no heartbeats, decides the leader is dead, and **promotes itself**. But the old leader is fine and still accepting writes from its side.

```text
before:  clients ──▶ leader(A) ──replicates──▶ follower(B)
after partition:
         clients X ──▶ A  "I'm leader"   ✂   B "I'm leader" ◀── clients Y
         both accept writes → two diverging histories → data conflicts or loss
```

That's **split brain**: two nodes both believing they are the leader. Defenses:

- **Quorums / majority voting**: a node may act as leader only if a **majority** of nodes agree. With 3 nodes, only one side of a partition can have 2. The minority side steps down. (Raft, Day 42.)
- **Fencing tokens**: each new leader gets a higher number (an *epoch* or *term*). Storage rejects writes carrying an older number, so a zombie old leader can't corrupt data.
- **STONITH**, "shoot the other node in the head": physically power off the old leader before promoting a new one. Crude but effective.

Why "just check if the leader is dead" doesn't work: a process paused for 15 seconds by garbage collection or a VM migration will wake up **believing it's still the leader**. It has no idea time passed. Fencing tokens protect against exactly this.

## Byzantine failures (briefly)

So far nodes are honest but unreliable: they crash, pause or lose messages (**crash faults**). A **Byzantine fault** is when a node sends wrong or malicious data. Most internal company systems assume crash faults only; blockchains and some aerospace systems design for Byzantine ones, at a big cost.

## The math

Partial failure isn't rare at scale; it's constant.

```text
One server is up 99.9% of the time.
Chance all of 1,000 servers are up at once = 0.999^1000 ≈ 0.37

→ 63% of the time, at least one is broken right now.

A request fans out to 100 backends in parallel, each 1% slow (over 1 s).
Chance at least one is slow = 1 − 0.99^100 ≈ 0.63
→ most user requests hit the slow tail somewhere.
```

That second result is why Google's "The Tail at Scale" paper argues tail latency dominates big systems. Expect failure as the normal state and design for it: timeouts on every call, retries with backoff (Day 43), redundancy, and graceful degradation (show the page without recommendations rather than not at all).

## In an interview

You'll rarely get "explain partial failure" directly, but every design deep-dive tests it: "What happens if this service is slow? If the network between regions drops? If the leader pauses?" Interviewers listen for:

- Every network call has a **timeout**, and you know a timeout is ambiguous.
- Retries are paired with **idempotency**.
- Leaders are protected against split brain (majority quorum, fencing).
- You degrade gracefully instead of failing entirely.

Good paragraph: "Across the network I can't distinguish a dead node from a slow one, so every call has a timeout set slightly above the callee's p99, and retries use backoff with idempotency keys because the first attempt may have succeeded. For leader election I'd rely on a majority quorum through something like etcd, and pass a fencing token with every write so a paused old leader can't overwrite newer data."

## Common mistakes

- **Treating a timeout as "it failed"**. It means "I don't know".
- **Infinite or missing timeouts**. One stuck dependency then exhausts your threads and takes you down too.
- **Retrying instantly and forever**, turning a small blip into a retry storm.
- **Thinking partitions are rare enough to ignore**. At scale, something is always broken.
- **Electing a leader by "whoever can't see the other"**: both sides do that. Require a majority.

## Before moving on

- [ ] I can explain partial failure using the unanswered text message
- [ ] I can list at least five fallacies of distributed computing
- [ ] I can explain why a timeout is ambiguous and what that means for retries
- [ ] I can describe split brain and two ways to prevent it
- [ ] I can compute the chance that at least one of N machines is down

## Go deeper (optional)

- *Designing Data-Intensive Applications*, Chapter 8 "The Trouble with Distributed Systems"
- [Wikipedia: Fallacies of distributed computing](https://en.wikipedia.org/wiki/Fallacies_of_distributed_computing)
- [Wikipedia: Split-brain (computing)](https://en.wikipedia.org/wiki/Split-brain_(computing))
- [Wikipedia: Two Generals' Problem](https://en.wikipedia.org/wiki/Two_Generals%27_Problem)
- Dean and Barroso, "The Tail at Scale", *Communications of the ACM*, 2013
