# HTTP: The Language of the Web

> Almost every API, website and mobile app speaks HTTP. Once you can read a raw request and response, know what the status codes and headers mean, and understand why HTTP/2 and HTTP/3 exist, a huge part of backend engineering stops being magic.

## The big idea

HTTP is a **restaurant order slip**. The customer (client) writes a slip: *what* they want to do (the **method**: "order"), *which* item (the **path**: `/menu/pizza`), some notes (**headers**: "no onions, I'm allergic to nuts, I'm at table 7") and maybe an attached sheet (the **body**). The kitchen (server) sends back a slip: a **status** ("200 here you go", "404 we don't have that", "500 the oven exploded"), notes (headers) and the food (body).

Two crucial properties:

- **Request–response:** the client always speaks first; the server only answers. (Day 18 covers how servers push data anyway.)
- **Stateless:** each request stands alone. The kitchen doesn't remember you from five minutes ago unless you show your table number again. That number is what **cookies** and **tokens** are.

HTTP runs on top of TCP (Day 12), or QUIC for HTTP/3, and usually inside TLS (Day 15), which makes it **HTTPS**.

## What a request and response really look like

HTTP/1.1 is plain text. This is literally what goes over the wire (lines end with `\r\n`; a blank line separates headers from body):

```text
POST /api/orders HTTP/1.1
Host: shop.example.com
Content-Type: application/json
Content-Length: 32
Authorization: Bearer eyJhbGciOi...
Accept: application/json

{"productId": 42, "quantity": 2}
```

```text
HTTP/1.1 201 Created
Content-Type: application/json
Content-Length: 43
Location: /api/orders/9001
Cache-Control: no-store

{"id": 9001, "status": "pending", "qty": 2}
```

The parts: a **request line** (method, path, version), **headers** (`Name: value`), a blank line, an optional **body**. The response swaps the request line for a **status line**.

You can make one by hand in JavaScript:

```js
// Works in modern browsers and Node 18+
const res = await fetch("https://api.github.com/repos/nodejs/node", {
  headers: { Accept: "application/json" },
});
console.log(res.status, res.headers.get("content-type"));
const repo = await res.json();
console.log(repo.stargazers_count);
```

And a tiny server:

```js
require("http").createServer((req, res) => {
  console.log(req.method, req.url, req.headers["user-agent"]);
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("hello\n");
}).listen(8080);
// then: curl -v http://localhost:8080/anything   (-v prints the raw headers)
```

## Methods

| Method | Meaning | Safe? | Idempotent? | Has body? |
|---|---|---|---|---|
| `GET` | Read a resource | Yes | Yes | No |
| `HEAD` | Like GET, headers only | Yes | Yes | No |
| `POST` | Create / submit / "do something" | No | **No** | Yes |
| `PUT` | Replace a resource entirely | No | Yes | Yes |
| `PATCH` | Partially update | No | Not guaranteed | Yes |
| `DELETE` | Remove | No | Yes | Usually no |
| `OPTIONS` | What's allowed here? (used by CORS preflight) | Yes | Yes | No |

- **Safe** = doesn't change anything on the server. Crawlers and prefetchers may call safe methods freely.
- **Idempotent** = doing it twice has the same effect as doing it once. `PUT /users/7 {name:"Ada"}` twice leaves the same state. `DELETE /users/7` twice: still deleted (the second may return 404, but the *state* is the same). `POST /orders` twice creates **two orders**.

Idempotency matters enormously for **retries** (Day 43). If a request times out, did it happen? For idempotent methods, you can just retry. For `POST`, you need an **idempotency key** header so the server can recognize the duplicate.

## Status codes

The first digit is the category:

| Range | Meaning | The ones to know |
|---|---|---|
| 1xx | Informational | `101 Switching Protocols` (WebSocket upgrade) |
| 2xx | Success | `200 OK`, `201 Created`, `204 No Content` |
| 3xx | Redirect / go elsewhere | `301 Moved Permanently`, `302 Found`, `304 Not Modified`, `307`/`308` (redirect keeping the method) |
| 4xx | **Client** made a mistake | `400 Bad Request`, `401 Unauthorized` (not logged in), `403 Forbidden` (logged in but not allowed), `404 Not Found`, `409 Conflict`, `429 Too Many Requests` |
| 5xx | **Server** failed | `500 Internal Server Error`, `502 Bad Gateway`, `503 Service Unavailable`, `504 Gateway Timeout` |

Why this matters in systems: **4xx means don't retry the same request** (it'll fail again), **5xx and 429 may be retried** with backoff. Load balancers and monitoring count 5xx as your fault and alert on them. `502`/`504` usually come from a proxy or load balancer saying "the app server behind me crashed / was too slow".

## Headers that matter

| Header | Direction | What it does |
|---|---|---|
| `Host` | req | Which site (many sites share one IP). Required in HTTP/1.1 |
| `Content-Type` | both | Format of the body: `application/json`, `text/html; charset=utf-8` |
| `Content-Length` | both | Body size in bytes, so the reader knows where it ends |
| `Accept`, `Accept-Encoding` | req | What formats/compression (`gzip`, `br`) the client understands |
| `Authorization` | req | Credentials, e.g. `Bearer <token>` |
| `User-Agent` | req | Which client software |
| `Location` | res | Where the new resource is (201) or where to go (3xx) |
| `Set-Cookie` / `Cookie` | res / req | Store state in the browser / send it back |
| `Cache-Control`, `ETag`, `Last-Modified` | res | Caching rules (below) |
| `Access-Control-Allow-Origin` | res | CORS: which other websites' JS may read this response |

## Cookies: memory for a stateless protocol

The server says `Set-Cookie: session=abc123; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`. From then on, the browser automatically attaches `Cookie: session=abc123` to every request to that site. The server looks up `abc123` in a session store and knows who you are.

The attributes are security features (Day 48):

- `HttpOnly`: JavaScript can't read it → stolen less easily by XSS.
- `Secure`: only sent over HTTPS.
- `SameSite=Lax/Strict`: not sent on most cross-site requests → helps against CSRF.
- `Max-Age`/`Expires`: lifetime; without it, it's deleted when the browser closes.

## Caching headers

The fastest request is the one you never make. HTTP has caching built in, used by browsers, CDNs (Day 30) and proxies.

- `Cache-Control: max-age=31536000, immutable` — "reuse this for a year, it will never change". Perfect for files with a hash in the name like `app.3f9a1c.js`.
- `Cache-Control: no-cache` — you may store it, but **check with the server** before each reuse. (Confusing name!)
- `Cache-Control: no-store` — never store it at all (bank statements, personal data).
- `Cache-Control: private` vs `public` — only the user's browser may cache it vs shared caches (CDNs) may too.

**Revalidation** with `ETag` saves bandwidth when the cache is stale:

```text
First response:   200 OK   ETag: "v42"   (body: 300 KB)
Later request:    GET /logo.png   If-None-Match: "v42"
If unchanged:     304 Not Modified   (no body: a few hundred bytes)
If changed:       200 OK   ETag: "v43"   (new body)
```

## The math: what caching saves

A page loads 40 static files averaging 50 KB = 2 MB. You have 1 million page views a day, and 70% are from returning visitors.

```text
No caching:            1,000,000 × 2 MB = 2,000,000 MB ≈ 2 TB/day served
Long max-age caching:  returning visitors download ~nothing
                       new visitors: 300,000 × 2 MB = 600 GB/day
Saved: ~1.4 TB/day (70%) — plus every returning visitor skips 40 requests.
```

At cloud egress prices around $0.05–0.09 per GB, 1.4 TB/day is roughly $2,000–3,800 a month saved, and much faster page loads.

## HTTP/1.1 vs HTTP/2 vs HTTP/3

**HTTP/1.1 (1997):** text-based. **Keep-alive** lets a connection carry many requests in sequence, but only **one at a time**: the next request waits for the previous response. Browsers work around this by opening up to **6 connections per host**, and developers resorted to tricks like bundling files and spriting images.

**HTTP/2 (2015):** same methods/headers/status codes, but a **binary** framing layer with **multiplexing**: many requests and responses interleave as streams over **one** TCP connection. Also **header compression** (HPACK) so repeated headers like cookies aren't resent in full. The catch: one lost TCP packet stalls all streams (TCP head-of-line blocking, Day 12).

**HTTP/3 (2022):** HTTP over **QUIC**, which runs on UDP. Each stream is independently reliable, so a loss only stalls its own stream. QUIC builds TLS 1.3 into its handshake: a fresh connection takes **1 RTT** instead of TCP+TLS's 2, and resumed connections can send data in **0 RTT**. Connections survive network changes (Wi-Fi → 4G) because they're identified by a connection ID, not the IP/port 4-tuple.

```text
                  HTTP/1.1            HTTP/2               HTTP/3
 Format           text                binary frames        binary frames
 Transport        TCP                 TCP                  QUIC (UDP)
 Parallelism      6 conns × 1 req     1 conn, many streams 1 conn, many streams
 HOL blocking     at HTTP level       at TCP level         mostly gone
 Setup (w/ TLS)   TCP 1 RTT + TLS 1   same                 1 RTT (0 on resume)
```

Request count math: a page with 60 assets, 100 ms RTT, HTTP/1.1 with 6 connections and no pipelining needs about `60 / 6 = 10` sequential rounds ≈ 1 s just in round trips. HTTP/2 can request all 60 at once: closer to 1–2 RTTs plus transfer time.

## In an interview

HTTP shows up everywhere: designing an API (Day 17), choosing status codes, retries and idempotency, caching strategy, "why HTTP/2?", cookies vs tokens.

What interviewers listen for: correct use of methods (GET has no side effects, POST isn't idempotent), meaningful status codes (4xx vs 5xx and what that implies for retries), caching headers for static assets vs personalized data, and awareness of connection costs. A good snippet: *"Static assets get content-hashed filenames and `Cache-Control: public, max-age=31536000, immutable`, served from a CDN. API responses with user data get `private, no-cache` or `no-store`. Order creation is a POST with an `Idempotency-Key` header so client retries after a timeout don't double-charge."*

## Common mistakes

- **Changing state with GET** (`GET /delete?id=5`). Crawlers, prefetchers and caches will happily trigger it.
- **401 vs 403.** 401 = "who are you?" (missing/invalid credentials). 403 = "I know who you are, and no."
- **Returning 200 with `{"error": ...}`.** Monitoring, caches and clients rely on status codes.
- **`no-cache` means "don't cache".** It means "revalidate first". `no-store` means don't cache.
- **"HTTP/2 makes my server faster."** It mainly saves round trips and connections; slow server code is still slow.

## Before moving on

- [ ] I can write a raw HTTP request and response from memory
- [ ] I can explain safe vs idempotent and classify GET, POST, PUT, DELETE
- [ ] I know the main status codes and which ones are worth retrying
- [ ] I can choose Cache-Control headers for a hashed JS file vs a user's profile
- [ ] I can explain what HTTP/2 and HTTP/3 each fixed

## Go deeper (optional)

- [MDN: An overview of HTTP](https://developer.mozilla.org/en-US/docs/Web/HTTP/Overview)
- [MDN: HTTP caching](https://developer.mozilla.org/en-US/docs/Web/HTTP/Caching)
- [MDN: HTTP response status codes](https://developer.mozilla.org/en-US/docs/Web/HTTP/Status)
- *High Performance Browser Networking* by Ilya Grigorik, chapters on HTTP/1.1 and HTTP/2
