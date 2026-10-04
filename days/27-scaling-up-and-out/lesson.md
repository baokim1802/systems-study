# Scaling Up and Out

> Every big system started as one program on one machine. Today is the story of how it grows: what breaks first, and the two basic ways to add capacity.

## The big idea

Picture a small coffee shop with one barista. Business booms and the line goes out the door. You have two options:

1. **Hire a faster barista and buy a bigger espresso machine.** One person, more power. That's **scaling up** (also called **vertical scaling**).
2. **Hire more baristas and add more espresso machines.** Many people working side by side. That's **scaling out** (also called **horizontal scaling**).

Option 1 is simple: nothing about how the shop works changes. But there's a limit to how fast one human can move, and the world's best barista is very expensive. Option 2 can grow almost forever, but now you need someone at the door to send customers to a free barista (a **load balancer**, Day 28), and the baristas need a shared way to know about each customer's loyalty card (shared **state**).

That's the whole lesson in miniature. Now the real version.

## Scaling up (vertical)

You move your app to a bigger machine: more CPU cores, more RAM, faster disks.

| Pros | Cons |
|---|---|
| No code changes | There's a ceiling: the biggest machine you can buy |
| No distributed-systems problems (no network between parts) | Price grows faster than power at the high end |
| Easy to reason about, easy to debug | Still a **single point of failure** (SPOF): one machine dies, everything is down |
| Great for databases, which are hard to split | Upgrading usually means downtime |

How big is "big"? Cloud providers rent single machines with hundreds of CPU cores and several terabytes of RAM. That's a lot. Many companies run surprisingly large businesses on one well-tuned database server plus a few copies. **Scaling up first is often the right call**: it's cheap in engineering time.

## Scaling out (horizontal)

You run **many copies** of your app on ordinary machines and spread the work between them.

| Pros | Cons |
|---|---|
| Nearly unlimited growth: add another machine | Needs a load balancer in front |
| No single point of failure: one dies, the others keep serving | State must live somewhere shared |
| Commodity machines are cheap; you can add/remove them as traffic changes (autoscaling) | More moving parts, more things to monitor |
| Deploy one machine at a time without downtime (Day 50) | Distributed-systems problems appear (Day 38) |

The catch is in the second row: scaling out only works smoothly if the copies are **interchangeable**. That requires being **stateless**.

## Stateless vs stateful

**State** is any data a server remembers between requests. A **stateless** server keeps nothing between requests that another server would need: every request carries (or can look up) everything needed to handle it. A **stateful** server keeps something important in its own memory or disk.

Here's a stateful server, written in Node.js with Express:

```js
// BAD (stateful): the cart lives in THIS process's memory
const carts = new Map(); // userId -> array of items

app.post('/cart', (req, res) => {
  const items = carts.get(req.userId) ?? [];
  items.push(req.body.item);
  carts.set(req.userId, items);
  res.json(items);
});
```

Works perfectly on one server. Now run three copies behind a load balancer:

```text
Request 1: "add shoes"  → Server A   (A's memory: [shoes])
Request 2: "add socks"  → Server B   (B's memory: [socks])     ← the cart "lost" the shoes!
Request 3: "view cart"  → Server C   (C's memory: [])          ← empty cart!
```

And if Server A restarts during a deploy, everything in its memory is gone.

The fix is to **move the state out** of the app server into a shared store that every copy talks to:

```js
// GOOD (stateless) app server: state lives in Redis (shared by all servers)
app.post('/cart', async (req, res) => {
  await redis.rPush(`cart:${req.userId}`, req.body.item);
  const items = await redis.lRange(`cart:${req.userId}`, 0, -1);
  res.json(items);
});
```

Now any server can handle any request, and you can add or remove servers freely. The **state didn't disappear**; it moved into a dedicated system (a database or cache) that's built to be shared, replicated (Day 31) and sharded (Day 32). That's the pattern everywhere: **stateless app tier, stateful data tier**.

## Sessions: the classic example

When you log in, the server needs to remember "this browser belongs to user 42". That memory is a **session**. Three common ways to handle it when you scale out:

1. **Sticky sessions.** The load balancer always sends the same user to the same server (Day 28). Simple, but if that server dies, its users are logged out, and load can become uneven. It's a band-aid, not a fix.
2. **Central session store.** The browser holds a random session ID in a cookie (Day 14). Servers look the ID up in a shared store such as Redis. Any server can handle any request. This is the most common answer.
3. **Self-contained tokens.** The server puts the user's identity in a signed token (like a JWT, Day 47) that the browser sends every time. Servers verify the signature and need no lookup at all. Trade-off: hard to revoke a token before it expires.

## The path from one server to many

Here's the typical journey. Each step fixes the bottleneck the previous step ran into.

```text
Stage 1: everything on one box
  [ users ] → [ web app + database ]

Stage 2: split the database onto its own machine (now each can be sized separately)
  [ users ] → [ web app ] → [ database ]

Stage 3: many stateless app servers behind a load balancer
  [ users ] → [ load balancer ] → [ app ][ app ][ app ] → [ database ]

Stage 4: add a cache to take reads off the database (Day 29)
                                   [ app ][ app ][ app ] → [ cache ] → [ database ]

Stage 5: read replicas for more read capacity and failover (Day 31)
                                                         → [ primary ] → [ replica ][ replica ]

Stage 6: CDN for static files and media (Day 30), queues for slow work (Day 34)

Stage 7: shard the database when writes or data size outgrow one primary (Day 32)
```

Notice the order. The app tier gets scaled out early because, once stateless, it's easy. The database stays scaled up for as long as possible because splitting data is the hardest part.

## Numbers: when does one machine stop being enough?

Use Day 26's estimation:

```text
App needs 30,000 peak QPS. One app server handles ~2,000 QPS.
→ scale out: 30,000 / 2,000 = 15 servers, ~20 with headroom.

Database receives 3,000 writes/s and 30,000 reads/s.
→ 3,000 writes/s: one strong primary can usually do this. Scale it up.
→ 30,000 reads/s: put a cache in front (90% hit rate leaves 3,000 reads/s for the DB).
```

And the cost curve: doubling one machine's size roughly doubles its price at the small and middle sizes, but the very largest machines often cost more per core. Ten mid-size servers are frequently cheaper than one giant one, *and* they survive a failure.

### Why you can't just add machines forever

Adding servers helps only the part of the work that can be split. If every request also takes a lock on one database row, or calls one service that can't scale, that shared piece becomes the limit. This idea has a name, **Amdahl's law** (Day 52): if 10% of the work can't be parallelized, you can never go more than 10× faster, no matter how many machines you add.

## In an interview

Interviewers love "how would this scale to 10× / 100× users?" A strong answer:

- Starts simple ("one server and one database would handle the first 10k users"),
- Names the **bottleneck** at each stage with a number,
- Makes app servers **stateless** and moves sessions/state to a shared store,
- **Scales out** the stateless tier behind a load balancer, **scales up** the database first, then adds a cache and read replicas, and shards only when needed,
- Mentions removing **single points of failure** (at least two of everything).

Sample answer: *"I'd keep the web tier stateless, with sessions in Redis, so I can run N identical servers behind a load balancer and autoscale them. The database is the hard part: I'd scale it up and add read replicas and a cache for the read-heavy traffic, and only shard when the write rate or data size outgrows a single primary, because sharding adds a lot of complexity."*

## Common mistakes

- **"Horizontal is always better."** It costs complexity. Many systems should scale up first.
- **Forgetting where the state went.** "Stateless" doesn't mean the data vanished: it means it lives in a shared store, which now needs its own scaling plan.
- **Sticky sessions as the main plan.** They hide state problems and break on server failure.
- **Local files on app servers.** Uploaded files saved to one server's disk are invisible to others. Use object storage (Day 36).
- **In-memory caches and timers per process.** A rate limit counter in one server's memory only counts that server's traffic (Day 35).

## Before moving on

- [ ] I can explain vertical vs horizontal scaling with pros and cons
- [ ] I can say what makes a server stateless and why it matters
- [ ] I know three ways to handle sessions across many servers
- [ ] I can sketch the stages from one server to a sharded system
- [ ] I can explain why the database is usually the last thing to scale out

## Go deeper (optional)

- *Designing Data-Intensive Applications*, chapter 1 ("Scalability")
- [The Twelve-Factor App](https://12factor.net/), especially factor VI, "Processes" (stateless processes)
- [Scalability on Wikipedia](https://en.wikipedia.org/wiki/Scalability)
