# What Happens When You Type a URL

> "What happens when you type google.com into your browser and press Enter?" is one of the most famous interview questions ever, because a good answer touches everything you've learned this week. Today we stitch DNS, TCP, TLS and HTTP together, follow one request into the server and back, and put real milliseconds on every step.

## The big idea

Ordering a pizza by phone from a restaurant you've never called before:

1. **Look up the number** in the phone book (DNS).
2. **Dial and wait for "hello?"** (TCP handshake).
3. **Agree on a secret code word** so the neighbors listening on the party line can't understand (TLS).
4. **Place the order** (HTTP request).
5. **The kitchen makes it**: checks the fridge, maybe calls the supplier (server, cache, database).
6. **Delivery arrives and you set the table**: plates, then food, then drinks as they come (browser parsing and rendering).

Every step costs time, and most of it is **waiting for messages to cross the network**, not computing. Keep that in mind; it's the key insight of this whole lesson.

## The timeline at a glance

Assume a user in Paris, a server in Frankfurt, **RTT = 20 ms**, nothing cached, HTTPS over TCP with TLS 1.3:

```text
 t = 0 ms     Enter pressed. Browser parses the URL.
 0 →  ~25     DNS lookup (cache miss at the resolver: a couple of round trips)
 25 → 45      TCP handshake                    (1 RTT)
 45 → 65      TLS 1.3 handshake                (1 RTT)
 65 → 85+     HTTP request → response starts   (1 RTT + server time, say 50 ms)
 ~135         First byte of HTML arrives       ("TTFB", time to first byte)
 135 → ~400   Parse HTML, fetch CSS/JS/images (reusing connections), run JS
 ~400–800     Page painted and interactive
```

Now the same page for a user in Sydney (RTT ≈ 280 ms to Frankfurt): DNS ~300, TCP 280, TLS 280, request 280 + 50 → first byte at around **1.2 seconds** before the browser has done anything. Same code, same server: distance alone costs a second. This is why CDNs and multi-region deploys exist (Days 30 and 51).

## Step 1: The browser parses what you typed

`https://shop.example.com:443/cart?item=42#reviews` breaks into:

| Part | Value | Meaning |
|---|---|---|
| scheme | `https` | Protocol: HTTP over TLS, default port 443 |
| host | `shop.example.com` | Needs DNS |
| port | `443` | Usually implied |
| path | `/cart` | Which resource |
| query | `?item=42` | Parameters |
| fragment | `#reviews` | **Never sent to the server**; the browser scrolls to it |

```js
const u = new URL("https://shop.example.com:443/cart?item=42#reviews");
console.log(u.hostname, u.port, u.pathname, u.searchParams.get("item"), u.hash);
// shop.example.com "" /cart 42 #reviews   (port is "" because 443 is the default for https)
```

If you typed `example` with no dot, the browser decides it's a search, not a URL. If the site is on the **HSTS** list (Strict-Transport-Security), the browser upgrades `http://` to `https://` itself, without a round trip.

## Step 2: DNS (Day 13)

The browser checks its own DNS cache, then asks the OS (which checks its cache and the `hosts` file), which asks the configured recursive resolver. On a miss, the resolver walks root → `.com` → `example.com`'s authoritative server and returns, say, `A 203.0.113.10, TTL 300`.

- Cached: ~0–2 ms. Uncached: ~20–100+ ms.
- If the site uses a CDN, the answer is often a CNAME to the CDN and an IP of a nearby **edge** server, so the next steps go to a machine maybe 5 ms away instead of 100.

## Step 3: TCP connection (Day 12)

The OS picks an ephemeral source port, and sends a SYN to `203.0.113.10:443`. The packet leaves through your Wi-Fi router (which NATs it, Day 11), travels hop by hop, and after SYN, SYN-ACK, ACK the connection exists. **Cost: 1 RTT.**

Browsers often open connections **speculatively** while you're still typing, and reuse existing ones whenever possible (keep-alive, HTTP/2's single connection per origin).

## Step 4: TLS handshake (Day 15)

ClientHello (with the hostname in the **SNI** field, so one IP can host many sites' certificates) → ServerHello + certificate + signature → keys derived. The browser validates the certificate chain against its trusted roots and checks the name matches `shop.example.com`. **Cost: 1 RTT with TLS 1.3** (2 with TLS 1.2). With HTTP/3, QUIC merges steps 3 and 4 into a single round trip.

## Step 5: The HTTP request (Day 14)

```text
GET /cart?item=42 HTTP/2
Host: shop.example.com           (":authority" in HTTP/2)
User-Agent: Mozilla/5.0 ...
Accept: text/html
Accept-Encoding: gzip, br
Cookie: session=abc123
```

The cookie tells the server who you are. Encryption wraps all of it; an observer sees only the IPs, ports and (usually) the hostname from SNI.

## Step 6: Inside the data center

The request rarely hits "the server" directly. A typical path:

```text
 Internet
    │
    ▼
 CDN edge / WAF ──(cache hit? serve static stuff right here)
    │
    ▼
 Load balancer (terminates TLS, picks a healthy app server)        Day 28
    │
    ▼
 App server (Node, Java, ...)
    ├─> session lookup in Redis          ~0.5 ms                    Day 29
    ├─> cache lookup for product data    ~0.5 ms
    ├─> database query on a miss         ~2–10 ms                   Day 20
    └─> calls to other services (cart, pricing)  ~5–20 ms each
    │
    ▼
 Renders HTML or JSON, compresses it (gzip/brotli), sends response
```

Server time is often **10–100 ms**: small compared with the network on a far-away connection, but it's the part you control directly, and it adds up fast if services call each other in sequence.

## Step 7: The response and the browser's work

```text
HTTP/2 200
Content-Type: text/html; charset=utf-8
Content-Encoding: br
Cache-Control: private, no-cache
Set-Cookie: ...
```

The browser now runs its **rendering pipeline**:

1. **Parse HTML** into the **DOM** (a tree of elements). This starts as bytes stream in; it doesn't wait for the whole file.
2. Discover sub-resources: `<link rel="stylesheet">`, `<script>`, `<img>`. Each needs a request, often to other hosts (CDN, fonts, analytics), meaning **more DNS + TCP + TLS** for each new origin.
3. **Parse CSS** into the **CSSOM**. CSS is **render-blocking**: the browser won't paint until it has the styles, to avoid a flash of unstyled content.
4. **Run JavaScript.** A plain `<script>` in the `<head>` is **parser-blocking**: HTML parsing stops until it downloads and runs. That's why we use `defer`/`async` or put scripts at the end.
5. **Layout:** compute the size and position of every box.
6. **Paint and composite:** fill in the pixels, layer by layer, using the GPU.

Then JavaScript keeps running on the event loop (Day 9), possibly making more API requests (`fetch`), and the page becomes interactive.

## The math: a realistic budget

Let's budget a cold page load from Sydney to a Frankfurt-only server, and then with improvements. RTT 280 ms, server time 50 ms, the HTML references CSS and JS on the same origin (fetched in parallel over HTTP/2 after the HTML arrives).

```text
                                  Frankfurt only     + CDN edge in Sydney (RTT 10 ms)
DNS (cold)                         ~300 ms             ~30 ms
TCP                                 280                 10
TLS 1.3                             280                 10
HTML request (edge→origin on miss)  280 + 50            10 + (280 + 50)  [dynamic HTML]
CSS + JS (1 more round trip)        280                 10   [static, cached at edge]
--------------------------------------------------------------------------
≈ total before first paint         ~1,470 ms           ~400 ms
```

The CDN version still pays one long trip for the dynamic HTML (the edge keeps a warm, already-open connection to the origin, so no extra handshakes), but every handshake and static file is local. Cutting **round trips** and **distance** beats optimizing server code by 10 ms.

## Ways to make it faster (cheat sheet)

| Step | Optimization |
|---|---|
| DNS | Longer TTLs for stable records, `dns-prefetch`, fewer distinct hostnames |
| TCP + TLS | Keep-alive and connection reuse, TLS 1.3, HTTP/3, `preconnect` hints, CDN edges near users |
| Request | HTTP/2 multiplexing, fewer render-blocking resources, compression (brotli/gzip) |
| Server | Caching (Redis, CDN), fast DB queries with indexes, parallel instead of sequential service calls |
| Browser | `defer` scripts, inline critical CSS, lazy-load images, smaller JS bundles |
| Next visit | Long-lived `Cache-Control` on hashed static files: zero requests for them |

## In an interview

Interviewers ask this to see breadth and how you **structure** a long answer. Don't drown in one layer. A good shape: name the steps in order, give one or two precise details per step, mention timings, then offer to go deeper wherever they want ("I can go into the TLS handshake or the rendering pipeline in more detail").

A compact answer: *"The browser parses the URL and checks HSTS and its caches. It resolves the hostname via DNS: browser, OS, then a recursive resolver that walks root, TLD and authoritative servers, caching by TTL. It opens a TCP connection (one RTT) and does a TLS 1.3 handshake (one more), verifying the certificate chain. It sends an HTTP GET with headers and cookies. On the server side, a CDN or load balancer terminates TLS and routes to an app server, which reads from caches and the database and returns HTML. The browser parses HTML into the DOM, fetches CSS, JS and images (more requests, reusing connections), builds the CSSOM, runs scripts, does layout and paint. On a far-away connection the round trips dominate, which is why we use CDNs, connection reuse and caching."*

## Common mistakes

- **Forgetting DNS or TLS entirely**, or putting TLS before TCP (with TCP-based HTTP, TLS runs *on top of* an established TCP connection).
- **Saying the fragment `#...` is sent to the server.** It isn't.
- **Going ten minutes deep into one layer** and never reaching rendering. Breadth first, then depth on request.
- **Ignoring that one page = dozens of requests.** The first HTML request is just the beginning.
- **Thinking the server is the slow part.** For far-away users, round trips usually dominate.

## Before moving on

- [ ] I can list the steps from URL to pixels in order without notes
- [ ] I can put an approximate millisecond cost on each network step given an RTT
- [ ] I can explain what's render-blocking and parser-blocking
- [ ] I can name three optimizations and which step each one speeds up
- [ ] I can give the two-minute version of this answer out loud

## Go deeper (optional)

- [GitHub: alex/what-happens-when](https://github.com/alex/what-happens-when) — an absurdly detailed community answer
- [MDN: How browsers work](https://developer.mozilla.org/en-US/docs/Web/Performance/How_browsers_work)
- [MDN: Critical rendering path](https://developer.mozilla.org/en-US/docs/Web/Performance/Critical_rendering_path)
- *High Performance Browser Networking* by Ilya Grigorik
