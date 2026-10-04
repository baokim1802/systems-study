# DNS

> Computers route by IP address, but humans type names like `github.com`. DNS, the Domain Name System, is the internet's giant, distributed, heavily cached phone book. It runs before almost every connection, it's a favorite tool for load balancing and failover, and "it's always DNS" is a running joke among engineers for good reason.

## The big idea

Imagine you need the phone number of "Dr. Lee at St. Mary's Hospital in Boston", and there's no single phone book for the whole world. You'd:

1. Ask a **librarian** (who does the legwork for you).
2. The librarian checks her notebook. If she looked it up recently, she answers right away.
3. Otherwise she asks the **world directory desk**: "who handles the US?" → "ask the US desk".
4. US desk: "who handles Boston hospitals?" → "ask St. Mary's switchboard".
5. St. Mary's switchboard: "Dr. Lee is extension 4417." That's the **authoritative** answer.
6. The librarian writes it in her notebook with a note "valid for 1 hour" and tells you.

That's DNS. The librarian is the **recursive resolver**, the desks are the **root**, **TLD** and **authoritative** name servers, and the notebook is the **cache** with a **TTL**.

## Names are a tree

Domain names are read right to left, from general to specific:

```text
                     . (root)
          ┌──────────┼───────────┐
         com        org         uk          ← top-level domains (TLDs)
       ┌──┴───┐      │           │
    github  google  wikipedia    co         ← second-level domains
      │       │      │           │
     api     www     en         bbc         ← subdomains
```

`api.github.com.` (the trailing dot is the root, usually hidden) means: under root, under `com`, under `github`, the name `api`. Each level can **delegate** the levels below it to someone else. Verisign runs `.com`, GitHub runs `github.com`, and GitHub can create `api.github.com` without asking anyone.

## The cast

| Player | Job | Examples |
|---|---|---|
| **Stub resolver** | Tiny client in your OS. Asks one resolver and waits. | Part of your OS / `getaddrinfo` |
| **Recursive resolver** | Does the full lookup on your behalf, and caches heavily | Your ISP's resolver, `8.8.8.8` (Google), `1.1.1.1` (Cloudflare) |
| **Root servers** | Know who runs each TLD | 13 named root servers (`a.root-servers.net` … `m.`), operated as 1,000+ instances worldwide via anycast |
| **TLD servers** | Know who is authoritative for each domain in their TLD | Verisign's servers for `.com` |
| **Authoritative servers** | Hold the actual records for a domain | Route 53, Cloudflare DNS, your company's servers |

## A full lookup, step by step

You type `api.example.com` with nothing cached anywhere:

```text
 Browser/OS ──(1) "api.example.com?"──> Recursive resolver (e.g. 1.1.1.1)
                                          │
              (2) "api.example.com?" ───> Root server
                  <── "I don't know, but .com is at a.gtld-servers.net (192.5.6.30)"
                                          │
              (3) "api.example.com?" ───> .com TLD server
                  <── "example.com is handled by ns1.example-dns.net (198.51.100.53)"
                                          │
              (4) "api.example.com?" ───> example.com's authoritative server
                  <── "api.example.com  A  203.0.113.10   TTL 300"
                                          │
 Browser/OS <──(5) "203.0.113.10" ────────┘   (resolver caches it for 300 s)
```

Notice the two styles: your machine asks the resolver a **recursive** query ("give me the final answer"), and the resolver asks the others **iterative** queries ("tell me the answer or who to ask next"). The answers that say "ask someone else" are **referrals**.

In practice the resolver almost always has the root and `.com` answers cached (their TTLs are 1–2 days), so a "cold" lookup is usually just one or two network round trips, not four. DNS mostly runs over **UDP port 53** (one small question, one small answer, no handshake; Day 12), falling back to TCP for large answers. Newer options encrypt it: DNS over HTTPS (DoH) and DNS over TLS (DoT).

## Record types

A domain's authoritative server stores **records**. The ones you'll actually use:

| Type | Maps | Example |
|---|---|---|
| `A` | name → IPv4 address | `example.com A 203.0.113.10` |
| `AAAA` | name → IPv6 address | `example.com AAAA 2001:db8::10` |
| `CNAME` | name → another name (an alias) | `www.example.com CNAME example.com` |
| `MX` | domain → mail servers, with priority | `example.com MX 10 mail.example.com` |
| `NS` | domain → its authoritative name servers | `example.com NS ns1.example-dns.net` |
| `TXT` | name → arbitrary text (verification, SPF/DKIM email auth) | `example.com TXT "v=spf1 include:_spf.google.com ~all"` |
| `SOA` | zone metadata (primary server, serial, default timers) | one per zone |

Two gotchas: a `CNAME` can't sit at the zone apex (`example.com` itself) alongside the other records there, which is why DNS providers invent "ALIAS"/"ANAME" records; and `CNAME` chains cost extra lookups.

Try it yourself:

```js
// Node: resolve records with the built-in dns module
const dns = require("dns").promises;
(async () => {
  console.log(await dns.resolve4("example.com", { ttl: true })); // [{ address, ttl }]
  console.log(await dns.resolveMx("gmail.com"));                // [{ exchange, priority }, ...]
  console.log(await dns.resolveTxt("google.com"));
})();
```

Or in a terminal: `dig example.com`, `dig +trace example.com` (shows every step from the root), `nslookup example.com`.

## TTL and caching

Every record has a **TTL (time to live)** in seconds: how long anyone may cache it. Caches exist at many levels: the browser (Chrome keeps its own small cache), the OS, your home router, the recursive resolver. That caching is why DNS can serve the whole internet: the vast majority of lookups never reach an authoritative server.

The trade-off is classic **freshness vs load/latency**:

| TTL | Good | Bad |
|---|---|---|
| Long (e.g. 86,400 s = 1 day) | Fewer lookups, faster for users, less load | A change (new IP, failover) takes up to a day to reach everyone |
| Short (e.g. 30–60 s) | Changes and failovers spread in about a minute | More lookups, more load on authoritative servers, slightly slower |

A standard migration trick: **lower the TTL days in advance** (from 1 day to 60 s), wait at least one old TTL so caches pick up the short one, switch the IP, verify, then raise the TTL again. Also know that some resolvers and clients don't honor TTLs perfectly (some apps cache resolved IPs forever, older JVMs were notorious), so keep the old server alive for a while after a switch.

## The math: how much do caches save?

Your domain gets traffic from users served by about **5,000 recursive resolvers** worldwide. Your `A` record has TTL = 300 s. At most, each resolver asks your authoritative servers once per TTL:

```text
max queries/s to your authoritative DNS ≈ resolvers / TTL
                                        = 5,000 / 300 ≈ 17 queries/s
```

Even if your users make 50,000 lookups per second, your DNS servers see about 17. Drop the TTL to 30 s and it rises to about 167/s, still tiny. That's why low TTLs are affordable, and why the real cost of a low TTL is more about **user latency on cache misses** than server load.

User-side: a cache-hit lookup is ~0 ms (local) to a few ms (nearby resolver); a miss might cost 20–100+ ms. Browsers hide some of this with **DNS prefetching** (`<link rel="dns-prefetch" href="//cdn.example.com">`).

## DNS as a load balancer

Because DNS decides which IP a client connects to, it's a powerful (if blunt) traffic-steering tool:

- **Round-robin DNS:** return several `A` records (`203.0.113.10`, `.11`, `.12`); clients typically pick the first, and the server rotates the order. Cheap, but DNS doesn't know if a server is down, and caching means changes are slow.
- **Health-checked DNS / failover:** the DNS provider probes your servers and stops returning dead ones (e.g. Route 53 health checks). Recovery speed is limited by the TTL.
- **GeoDNS / latency-based routing:** answer differently depending on where the resolver is: Europeans get the Frankfurt IP, Japanese users get Tokyo. This is how many CDNs (Day 30) and multi-region apps (Day 51) send users to a nearby region.
- **Weighted records:** send 5% of traffic to the new cluster, a crude canary (Day 50).

Limits: the DNS server sees the **resolver's** IP, not the user's (an extension called EDNS Client Subnet helps), and you can't control how long clients actually cache. So DNS is usually the **coarse** layer (which region or cluster), with real load balancers (Day 28) doing fine-grained per-request balancing behind a stable IP.

A related trick, **anycast**, announces the *same* IP from many locations via BGP (Day 11), so the network itself delivers each user to the nearest one. `1.1.1.1` and `8.8.8.8` and the root servers all work this way.

## When DNS goes wrong

- **Outage of your DNS provider:** if nobody can resolve your name, your perfectly healthy servers are unreachable. The 2016 Dyn DDoS attack took down Twitter, GitHub and others this way. Mitigation: use two providers, or a provider with a strong track record, and reasonable TTLs so caches ride out short blips.
- **Stale caches after a change:** some users hit the old IP for hours. Plan migrations with the TTL trick.
- **Spoofing/cache poisoning:** an attacker tricks a resolver into caching a fake answer. Random query IDs and source ports make this hard; **DNSSEC** adds cryptographic signatures to records.

## In an interview

DNS appears at the very start of "what happens when you type a URL" (Day 16), in multi-region designs ("how do users reach the nearest region?"), and in reliability discussions ("how do you fail over a region?").

A good answer: *"The browser asks the OS, which asks a recursive resolver. If it isn't cached, the resolver walks the hierarchy: root servers point to the TLD servers, which point to the domain's authoritative servers, which return the record, say an A record with a TTL. Everything along the way caches for the TTL, which keeps DNS fast and scalable but means changes propagate slowly. For multi-region I'd use latency- or geo-based DNS with health checks to send users to the nearest healthy region, with a TTL around 60 seconds for failover, and normal load balancers inside each region."*

## Common mistakes

- **"DNS changes propagate."** Nothing is pushed; caches just expire. "Propagation time" is really "the old TTL".
- **"Round-robin DNS is a load balancer."** It distributes clients roughly, but has no health awareness and no control over caching. Use it for coarse steering only.
- **"The root servers handle all lookups."** They handle very few, thanks to caching of TLD referrals.
- **Forgetting DNS in latency budgets.** A cold lookup is a real chunk of the first page load.
- **Using CNAME at the apex**: not allowed by the standard; use your provider's ALIAS feature.

## Before moving on

- [ ] I can walk through a full lookup: stub → recursive → root → TLD → authoritative
- [ ] I can explain A, AAAA, CNAME, MX, NS and TXT records
- [ ] I can explain the TTL trade-off and the "lower TTL before migrating" trick
- [ ] I can estimate queries per second hitting authoritative servers
- [ ] I can describe DNS-based load balancing and its limits

## Go deeper (optional)

- [Wikipedia: Domain Name System](https://en.wikipedia.org/wiki/Domain_Name_System)
- [Cloudflare Learning Center: What is DNS?](https://www.cloudflare.com/learning/dns/what-is-dns/)
- [Node.js docs: dns module](https://nodejs.org/api/dns.html)
- [RFC 1034: Domain names, concepts and facilities](https://www.rfc-editor.org/rfc/rfc1034)
