# CDNs and the Edge

> You can make your servers faster, but you can't make light faster. A CDN beats physics by moving copies of your content close to the people who want it.

## The big idea

A popular bakery in Paris starts getting orders from Tokyo, New York and São Paulo. Shipping every croissant from Paris takes days, and they arrive stale. The fix: open small shops in each city that bake (or stock) the bestsellers locally. Customers get them fresh in minutes, and the Paris kitchen only handles what the local shops don't have.

A **CDN** (content delivery network) does this for websites. It's a company (Cloudflare, Akamai, Fastly, Amazon CloudFront, and others) running thousands of servers in hundreds of cities. These locations are called **PoPs** (points of presence) or **edge locations**, because they sit at the "edge" of the network, near users. Your own servers become the **origin**: the source of truth that the CDN fetches from when it doesn't have something.

```text
Without a CDN:  user in Sydney ───────── ~16,000 km ─────────► origin in Virginia

With a CDN:     user in Sydney ── 20 km ──► Sydney PoP ──(only on a miss)──► origin
```

It's Day 29's caching idea, applied to geography.

## The math: why distance matters

Light in a vacuum travels about 300,000 km/s. In optical fiber it's slower, about **200,000 km/s** (roughly two-thirds of `c`, because glass slows light down). That gives a handy rule:

```text
200,000 km/s = 200 km per millisecond
→ one-way delay ≈ distance_km / 200   ms
→ round trip (RTT) ≈ distance_km / 100   ms     (the absolute best case)
```

Real cables don't follow straight lines, and routers add delay, so real RTTs are often 1.5–2× the ideal.

| Route | Distance (approx.) | Ideal RTT | Typical real RTT |
|---|---|---|---|
| Same city | 50 km | 0.5 ms | 1–5 ms |
| New York ↔ London | 5,600 km | 56 ms | ~70–80 ms |
| London ↔ Sydney | 17,000 km | 170 ms | ~250–300 ms |

Now remember from Days 12, 15 and 16 that a fresh HTTPS request needs several round trips before any content arrives:

```text
TCP handshake           1 RTT
TLS 1.3 handshake       1 RTT
HTTP request/response   1 RTT
──────────────────────────────
≈ 3 RTTs to get the first byte of a page on a new connection
```

Worked example, a user in Sydney:

```text
Origin in London, RTT 280 ms:   3 × 280 = 840 ms before the first byte
Sydney PoP, RTT 10 ms:          3 × 10  =  30 ms  (if the PoP has it cached)
```

That's almost a full second saved per new connection, and a page loads dozens of files. No amount of server optimization can win that back, because **you can't beat the speed of light**. You can only shorten the distance.

## How a CDN actually works

### 1. Getting users to the nearest PoP

When you put `www.example.com` behind a CDN, you point its DNS at the CDN. The CDN then routes each user to a nearby PoP using either:

- **DNS-based routing**: the CDN's DNS answers with the IP of a PoP near the user's resolver (GeoDNS, Day 13), or
- **Anycast**: every PoP announces the same IP address, and internet routing delivers packets to the nearest one (Day 28).

### 2. Cache hit or miss at the PoP

```text
user ──GET /logo.png──► PoP
                          │ in cache and still fresh? ── yes ──► return it (HIT, ~ms)
                          │ no
                          ▼
                     origin (or a "shield" PoP) ──► PoP stores a copy ──► return it (MISS)
```

Many CDNs add an **origin shield**: a middle-tier PoP that all edge PoPs ask before going to the origin. If 200 PoPs all miss on a new file, the origin sees one request instead of 200.

### 3. How long to keep it: Cache-Control

The origin tells the CDN (and browsers) how long things may be cached using HTTP headers (Day 14):

```text
Cache-Control: public, max-age=31536000, immutable     ← cache for a year, never revalidate
Cache-Control: public, max-age=60, s-maxage=300        ← browsers 60 s, shared caches (CDN) 300 s
Cache-Control: private, no-store                       ← never cache (personal or sensitive data)
```

`s-maxage` applies only to shared caches such as CDNs. `private` means "only the user's own browser may cache this".

### 4. The cache key

The **cache key** is what the CDN uses to decide "is this the same thing I already have?". By default it's roughly the host + path + query string:

```text
https://shop.com/products/42?color=red   → one cache entry
https://shop.com/products/42?color=blue  → a different entry
```

Getting the key right matters a lot:

- **Too specific** and the hit rate collapses. If tracking parameters like `?utm_source=newsletter` are part of the key, every campaign link creates a new cache entry. Strip parameters that don't change the content.
- **Too broad** and users see the wrong content. If a page differs by language but the key ignores `Accept-Language`, French users may get the German page. The `Vary` header tells caches which request headers change the response (`Vary: Accept-Encoding` is the common, safe one).
- **Never cache personalized responses under a shared key.** Caching a logged-in page as public can show one user's account page to others. This has caused real data leaks.

### 5. Cache busting with versioned file names

How do you update a file cached for a year? You don't: you give the new version a **new name**. Build tools put a hash of the content in the file name:

```text
app.3f9a2c1b.js     ← cached forever
app.8d41e07a.js     ← new deploy = new URL = new cache entry, instantly
```

The HTML page (short TTL) points to the latest name. This is the standard trick for JS, CSS and images.

For things that can't be renamed, CDNs offer **purge** (invalidate) APIs to remove an item from all PoPs, usually taking seconds.

## Push vs pull CDNs

| | Pull CDN | Push CDN |
|---|---|---|
| How content gets to the edge | PoP fetches from origin on the first miss | You upload content to the CDN ahead of time |
| Setup | Easy: point DNS, set headers | You manage uploads and deletions |
| First request | Slow (a miss) | Fast (already there) |
| Best for | Websites, APIs, most traffic | Large files known in advance: game patches, video catalogs, software releases |

Most websites use pull. Big media and download platforms often push (or pre-warm) popular files before a launch.

## What to put on a CDN

- **Static assets**: images, JS, CSS, fonts. The classic use; hit rates of 95%+ are common.
- **Media**: video segments (Day 59), audio, downloads. Here the CDN mainly saves **bandwidth**.
- **Cacheable API responses**: product catalogs, public pages, with short TTLs (even 5 seconds helps a lot for hot content).
- **Not cacheable but still faster through a CDN**: dynamic requests still benefit, because the user does the TCP/TLS handshake with the nearby PoP, and the PoP reuses warm, long-lived connections to the origin over the CDN's well-tuned backbone.

CDNs also act as a shield: they absorb DDoS attacks, often run a web application firewall (WAF), and hide your origin's address.

### Bandwidth math

```text
A video site serves 2 PB/month.
Without a CDN, all of it leaves your origin.
With a 97% CDN hit ratio, the origin serves only 3% = 60 TB/month.
```

That **offload** saves both money and origin capacity.

## Edge compute

Modern CDNs also let you run small pieces of code **at the PoP**: Cloudflare Workers, Fastly Compute, AWS Lambda@Edge / CloudFront Functions. Typical uses:

- Redirects, rewrites and A/B test bucketing without a round trip to the origin.
- Checking an auth token or a signed URL at the edge, rejecting bad requests early.
- Personalizing a mostly-cached page (fill in the user's name, country-specific prices).
- Serving from an edge key-value store for data that's read globally and changes rarely.

A Cloudflare Worker, for example, is a small JavaScript module that handles a `Request` and returns a `Response`:

```js
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const country = request.headers.get('CF-IPCountry') ?? 'US';
    if (url.pathname === '/') {
      return Response.redirect(`${url.origin}/${country.toLowerCase()}/`, 302);
    }
    return fetch(request); // pass everything else through (to cache or origin)
  },
};
```

The limit is data: edge code is fast only if it doesn't need to call a database that lives on another continent. If every edge request still waits 250 ms for the origin database, you've gained little.

## In an interview

Whenever your design serves images, video, static files or global users, mention a CDN. Interviewers listen for:

- **Why**: latency (distance, RTTs) and offload (bandwidth, origin load).
- **How it stays correct**: `Cache-Control` TTLs, versioned file names, purge, and never caching private data under a shared key.
- **Numbers**: hit ratio and what reaches the origin.

Sample answer: *"All static assets and image thumbnails go through a pull CDN. Assets have content-hashed names and a one-year TTL, so deploys never need a purge. Thumbnails get a 1-day TTL. With a 95% hit ratio, our 40 Gbps of image traffic becomes 2 Gbps at the origin, and users in Asia get images from a nearby PoP in ~20 ms instead of ~200 ms from our US region."*

## Common mistakes

- **Thinking the CDN makes the origin unnecessary.** The origin is still the source of truth and handles all misses.
- **Caching personalized pages publicly.** Use `private` or `no-store`, or vary the key correctly.
- **Long TTLs on files that keep the same name.** Users get stuck on old JS for days. Use hashed names.
- **Noisy cache keys** (tracking parameters, random query strings) that kill the hit rate.
- **Forgetting the first byte needs several round trips.** Distance hurts more than one RTT suggests.

## Before moving on

- [ ] I can estimate RTT from distance (`distance_km / 100` ms, best case)
- [ ] I can explain how a request reaches a nearby PoP and what happens on a miss
- [ ] I can explain cache keys, `Cache-Control`, `s-maxage` and versioned file names
- [ ] I know when to use push vs pull
- [ ] I can name three things edge compute is good for, and its main limit

## Go deeper (optional)

- [Content delivery network on Wikipedia](https://en.wikipedia.org/wiki/Content_delivery_network)
- [MDN: HTTP caching](https://developer.mozilla.org/en-US/docs/Web/HTTP/Caching)
- [MDN: Cache-Control](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Cache-Control)
- Ilya Grigorik, *High Performance Browser Networking* (free online), chapters on latency and TCP
