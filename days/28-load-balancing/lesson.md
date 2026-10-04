# Load Balancing

> Once you have many servers, something has to decide which one handles each request. That "something" is the load balancer, and the way it chooses decides how fast, fair and fault-tolerant your system is.

## The big idea

Think of the host at a busy restaurant. Guests walk in, and the host decides which waiter's section to seat them in. A lazy host just rotates: table for waiter 1, then 2, then 3. A smarter host looks at who's least busy. A host who knows the regulars seats them with the same waiter every time. And if a waiter goes home sick, a good host stops seating people in that section.

A **load balancer** (LB) is that host. It sits in front of a group of servers (called a **pool**, **backend** or **upstream**), receives every incoming request, and forwards each one to a healthy server. Clients only ever see the load balancer's address.

```text
                         ┌──────────► [ server A ]
[ clients ] ──► [ load balancer ] ───► [ server B ]
                         └──────────► [ server C ]  ✗ (failed health check, skipped)
```

It gives you three things:

1. **Scale**: spread work across many machines (Day 27).
2. **Availability**: route around dead servers automatically.
3. **Flexibility**: add, remove or upgrade servers without clients noticing (rolling deploys, Day 50).

## L4 vs L7: how deep does it look?

Remember the network layers from Day 11. Load balancers come in two main flavors depending on how much of the traffic they read.

**Layer 4 (transport) load balancer.** It sees only IP addresses and ports, and works with TCP/UDP connections (Day 12). It picks a server when a connection opens and then just shovels packets back and forth. It never reads the HTTP request inside.

**Layer 7 (application) load balancer.** It terminates the connection, reads the actual HTTP request (URL, headers, cookies), then opens or reuses its own connection to a backend. Because it understands HTTP, it can make smart decisions.

| | L4 | L7 |
|---|---|---|
| Sees | IPs, ports, TCP/UDP | Full HTTP: path, headers, cookies |
| Speed | Very fast, little CPU per packet | More work per request (parsing, often TLS) |
| Routing by URL (`/api` vs `/images`) | No | Yes |
| TLS termination (decrypt HTTPS) | Usually passes it through | Yes, commonly |
| Can retry a failed request on another server | No (only knows connections) | Yes |
| Works for non-HTTP (databases, games, MQTT) | Yes | Only for protocols it understands |
| Examples | AWS NLB, Linux IPVS, HAProxy in TCP mode | Nginx, Envoy, HAProxy in HTTP mode, AWS ALB |

A common setup uses both: a fast L4 layer spreads connections across a fleet of L7 proxies, which then do the clever HTTP routing.

## Balancing algorithms

### Round robin

Send request 1 to A, 2 to B, 3 to C, 4 to A again, and so on.

```js
class RoundRobin {
  constructor(servers) { this.servers = servers; this.i = 0; }
  pick() {
    const s = this.servers[this.i];
    this.i = (this.i + 1) % this.servers.length;
    return s;
  }
}
const lb = new RoundRobin(['A', 'B', 'C']);
console.log([1, 2, 3, 4, 5].map(() => lb.pick())); // [ 'A', 'B', 'C', 'A', 'B' ]
```

Simple and fair *if* every request costs the same and every server is equally powerful. Neither is usually true: one request may be a 2 ms cache hit and the next a 3-second report.

**Weighted round robin** gives a bigger server a bigger share: weights `A:3, B:1` means A gets 3 out of every 4 requests.

### Least connections

Send the request to the server with the fewest requests in progress right now. Slow requests keep a server's count high, so new traffic naturally flows elsewhere. This adapts to uneven request costs and is a great default for long or variable requests (WebSockets, Day 18; file uploads).

```js
function leastConnections(servers) {
  // servers: [{ name: 'A', active: 12 }, { name: 'B', active: 3 }, ...]
  return servers.reduce((best, s) => (s.active < best.active ? s : best));
}
```

A variant, **least response time**, also weighs in how fast each server has been answering.

### Power of two random choices

Checking every server's load is expensive when you have hundreds of servers and many load balancers each with a slightly stale view. A beautiful trick: pick **two servers at random** and send the request to the less loaded of the two.

```js
function powerOfTwo(servers) {
  const a = servers[Math.floor(Math.random() * servers.length)];
  const b = servers[Math.floor(Math.random() * servers.length)];
  return a.active <= b.active ? a : b;
}
```

It sounds too simple to work, but the math is striking. Throw `n` balls into `n` bins completely at random, and the fullest bin ends up with about `log n / log log n` balls. Let each ball pick the less full of **two** random bins, and the fullest bin drops to about `log log n / log 2`, an exponential improvement. Simulate it with `n = 1,000,000` and you get a fullest bin of about 8 with one random choice vs about 4 with two. Envoy and Nginx both offer this algorithm.

### Hashing

Compute `hash(something) % number_of_servers` and always send matching requests to the same server. The "something" might be the client IP, a user ID, or a URL.

- Useful when a server keeps a **local cache** for certain keys: the same user hitting the same server means a warm cache.
- The problem: if the number of servers changes from 4 to 5, `% n` changes for almost every key, so almost everyone gets reshuffled. **Consistent hashing** (Day 33) fixes that.

### Quick comparison

| Algorithm | Good for | Weak spot |
|---|---|---|
| Round robin | Uniform, short requests | Ignores how busy servers really are |
| Weighted round robin | Mixed server sizes | Still blind to actual load |
| Least connections | Variable or long-lived requests | Needs accurate connection counts |
| Power of two choices | Large fleets, many LBs | Slightly random, not perfectly optimal |
| Hash (IP, user, URL) | Cache affinity, stickiness | Uneven if keys are skewed; reshuffles on resize |

## Health checks

The LB must know which servers are alive. Two kinds:

- **Active health checks**: every few seconds the LB calls something like `GET /healthz` on each server. If it fails, say, 3 times in a row, the server is marked unhealthy and removed from rotation. After a few successes, it's added back.
- **Passive health checks** (outlier detection): the LB watches real traffic. If a server keeps returning errors or timing out, it gets ejected for a while.

What should `/healthz` check? If it only returns `200 OK` it proves the process is running, but not that it can do useful work. If it checks the database too, then a database blip makes *every* server fail its health check at once and the LB has nothing left to route to. A common compromise: a **liveness** check (is the process OK?) and a separate **readiness** check (can it serve traffic now?), as Kubernetes does (Day 49).

```js
app.get('/healthz', (req, res) => res.send('ok'));             // liveness: process is up
app.get('/ready', async (req, res) => {                          // readiness: dependencies OK
  try { await db.query('SELECT 1'); res.send('ready'); }
  catch { res.status(503).send('not ready'); }
});
```

**Math of detection time.** With checks every 5 seconds and 3 failures needed, a dead server can keep receiving traffic for up to `3 × 5 = 15` seconds (plus timeouts). At 1,000 QPS sent to that server, that's up to ~15,000 failed requests unless the LB also retries on another server. That's why passive checks and retries matter.

## Sticky sessions

**Session affinity** ("sticky sessions") means the LB sends the same client to the same server every time, usually by setting a cookie that names the server, or by hashing the client's IP.

Useful when servers hold per-user state in memory (like a WebSocket connection or a warm cache). But as Day 27 explained, it's fragile: a server dying logs out its users, and one server can get stuck with a few very heavy users. Prefer stateless servers and use stickiness only as an optimization.

## Global load balancing

So far the LB lives in one data center. If you have data centers in Virginia, Frankfurt and Tokyo, how does a user get sent to the closest healthy one?

- **DNS-based (GeoDNS)**: the DNS server (Day 13) answers with a different IP depending on where the user's resolver is. Short TTLs let you shift traffic away from a failed region, but caches don't always respect TTLs, so failover can take minutes.
- **Anycast**: many locations announce the **same IP address** over the internet's routing system (BGP), and routers naturally deliver packets to the nearest one. Used by CDNs (Day 30) and public DNS resolvers like `1.1.1.1` and `8.8.8.8`. Failover happens as fast as routing updates.

```text
user in Paris ──DNS──► "app.example.com = 203.0.113.10 (Frankfurt)"
                         └► Frankfurt L4 LB ► L7 proxies ► app servers
```

## Isn't the load balancer a single point of failure?

Yes, if there's only one. Real setups run LBs in **pairs or fleets**: two machines sharing a "floating" IP that moves to the standby if the active one dies (e.g. using VRRP / keepalived), or many LB nodes behind anycast or DNS. Cloud load balancers (AWS ELB, Google Cloud Load Balancing) handle this for you and spread across availability zones.

## In an interview

You'll draw a load balancer in nearly every design. Interviewers listen for:

- That you put it there for a reason (scale *and* availability) and that app servers behind it are stateless.
- L4 vs L7 and why you'd pick one: L7 for HTTP routing, TLS termination and retries; L4 for raw speed or non-HTTP protocols.
- A sensible algorithm: least connections for variable work, hashing when cache affinity matters (and consistent hashing so resizing doesn't reshuffle everything).
- Health checks, and that the LB itself is redundant.

Sample answer: *"Clients hit a managed L7 load balancer that terminates TLS and routes `/api` to the API pool and `/ws` to the WebSocket pool. It uses least-connections because request times vary, runs health checks every few seconds, and retries idempotent requests on another server. The LB is redundant across two availability zones, and GeoDNS sends users to the nearest region."*

## Common mistakes

- **Thinking round robin balances load.** It balances *requests*, not *work*.
- **Health checks that check everything.** A shared dependency failing makes all servers "unhealthy" at once.
- **Forgetting the LB can fail.** Always have at least two.
- **Using `hash % n` for cache affinity** and being surprised when adding a server sends every user to a cold cache.
- **Retrying non-idempotent requests** (like "charge card") on another server. Only safely retry what can be repeated (Day 43).

## Before moving on

- [ ] I can explain L4 vs L7 load balancing and give a reason to pick each
- [ ] I can implement round robin and least connections in a few lines
- [ ] I can explain why "power of two random choices" works so well
- [ ] I know active vs passive health checks and liveness vs readiness
- [ ] I can describe GeoDNS and anycast for global traffic

## Go deeper (optional)

- [Load balancing (computing) on Wikipedia](https://en.wikipedia.org/wiki/Load_balancing_(computing))
- [Anycast on Wikipedia](https://en.wikipedia.org/wiki/Anycast)
- Michael Mitzenmacher, "The Power of Two Choices in Randomized Load Balancing" (PhD thesis, 1996)
- [NGINX documentation: HTTP load balancing](https://docs.nginx.com/nginx/admin-guide/load-balancer/http-load-balancer/)
