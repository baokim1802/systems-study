# Real-Time Communication: Polling, SSE, WebSockets and Webhooks

> Plain HTTP is "you ask, I answer". But chat messages, live scores, stock tickers and "your ride is arriving" need the server to tell *you* something the moment it happens. Today you learn the five ways to do that, what each costs, and how to keep millions of connections open at once.

## The big idea

Imagine you're waiting for a package.

- **Polling:** you walk to the front door every 5 minutes to check. Mostly there's nothing. You waste a lot of walks, and when the package does come you notice it up to 5 minutes late.
- **Long polling:** you open the door and *stand there* until the courier arrives (or you get bored after 30 seconds and start again). No wasted trips, but you're tied up at the door.
- **Server-sent events (SSE):** you give the courier company a phone line that stays open; they talk, you only listen.
- **WebSocket:** a walkie-talkie. Either side can talk at any time over one open channel.
- **Webhook:** you're not home at all. You leave a note: "when it arrives, call this number". The *company's* system calls *your* system.

The core problem: in HTTP (Day 14), **only the client can start a conversation**. A server can't just "send" to a browser that hasn't asked. Every technique below is a way around that rule.

## Technique 1: Short polling

The client asks on a timer: "anything new?"

```js
// Ask every 5 seconds
setInterval(async () => {
  const res = await fetch('/api/messages?since=' + lastSeenId);
  const msgs = await res.json();
  if (msgs.length) render(msgs);
}, 5000);
```

- **Good:** dead simple, works through every proxy and firewall, stateless servers.
- **Bad:** most responses are empty, and the delay is up to one interval (average half of it).

The cost is easy to underestimate. Each poll is a full HTTP request with headers (often 500–800 bytes of headers alone, more with cookies).

```text
1,000,000 users online, polling every 5 s
  requests/sec = 1,000,000 / 5 = 200,000 req/s
  if 95% come back empty -> 190,000 req/s of pure waste
  average extra delay = 5 s / 2 = 2.5 s
```

Polling is fine when updates are rare and delay doesn't matter (checking an export job every 10 s), and terrible for chat.

## Technique 2: Long polling

The client asks, and the server **holds the request open** until there's news or a timeout (say 30 s). Then the client immediately asks again.

```text
client                         server
  | GET /messages?since=41  ---> |
  |                              |  (nothing yet... waits)
  |                              |  message 42 arrives!
  | <--- 200 [msg 42]            |
  | GET /messages?since=42  ---> |  (waits again)
  |                              |  30 s pass, nothing
  | <--- 204 No Content          |
  | GET /messages?since=42  ---> |
```

- **Good:** near-instant delivery, works over plain HTTP, no new protocol.
- **Bad:** the server must keep one parked request per waiting user; every message costs a new request; messages arriving *between* a response and the next request need the `since` cursor so nothing is lost.

Early Facebook chat and many early web apps used long polling. It's still a solid fallback when WebSockets are blocked.

## Technique 3: Server-sent events (SSE)

The client makes **one** HTTP request and the server never "finishes" the response. It keeps writing small text events down the same connection, with `Content-Type: text/event-stream`.

```text
HTTP/1.1 200 OK
Content-Type: text/event-stream

id: 101
data: {"score": "2-1"}

id: 102
event: goal
data: {"player": "Son"}

```

Each event is a few `field: value` lines ended by a blank line. In the browser:

```js
const es = new EventSource('/scores/stream');
es.onmessage = (e) => console.log('update', JSON.parse(e.data));
es.addEventListener('goal', (e) => celebrate(JSON.parse(e.data)));
```

A tiny Node server:

```js
import http from 'node:http';
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  let id = 0;
  const timer = setInterval(() => {
    res.write(`id: ${++id}\ndata: ${JSON.stringify({ t: Date.now() })}\n\n`);
  }, 1000);
  req.on('close', () => clearInterval(timer));
}).listen(3000);
```

- **One direction only:** server → client. The client still sends with normal `fetch` POSTs.
- **Built-in reconnection:** if the connection drops, `EventSource` reconnects by itself and sends a `Last-Event-ID` header, so the server can resend what was missed.
- **Text only** (UTF-8). Fine for JSON.
- **Watch out:** on HTTP/1.1 browsers allow only about **6 connections per domain**, so 7 tabs each with an SSE stream can starve each other. HTTP/2 multiplexes many streams over one connection (Day 14), which removes the problem.

SSE is underrated: perfect for notifications, live dashboards, progress bars, and streaming AI responses token by token.

## Technique 4: WebSockets

A WebSocket starts life as an HTTP request that asks to **upgrade** the connection to a different protocol:

```text
GET /chat HTTP/1.1
Host: example.com
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==
Sec-WebSocket-Version: 13

HTTP/1.1 101 Switching Protocols
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=
```

After the `101` response, the same TCP connection (Day 12) stops speaking HTTP. Both sides now send small **frames** (2–14 bytes of header plus your payload) whenever they like: **full duplex**. The `Sec-WebSocket-Accept` is just a hash of the key, proving the server really understands WebSockets (it's not security). Use `wss://` (WebSocket over TLS, Day 15) in production.

```js
const ws = new WebSocket('wss://example.com/chat');
ws.onopen = () => ws.send(JSON.stringify({ type: 'join', room: 'general' }));
ws.onmessage = (e) => showMessage(JSON.parse(e.data));
ws.onclose = () => setTimeout(reconnect, 1000 + Math.random() * 1000);
```

- **Good:** lowest overhead per message, both directions, binary or text. Ideal for chat, multiplayer games, collaborative editing (Day 64).
- **Bad:** *stateful*. A connection lives on one specific server, so load balancing, deploys and scaling get harder. No automatic reconnection or message replay: you build that yourself.

## Technique 5: Webhooks

Webhooks are **server-to-server**. Instead of your backend polling Stripe "has the payment succeeded yet?", you register a URL, and Stripe sends an HTTP `POST` to it when the event happens.

```text
  your server  --(1) register https://shop.com/hooks/stripe-->  Stripe
  customer pays...
  your server  <--(2) POST /hooks/stripe {type:"payment.succeeded"}--  Stripe
  your server  --(3) 200 OK-->  Stripe
```

Things every webhook receiver must handle:

1. **Verify it's real.** Anyone can POST to your URL. Providers sign the body with a shared secret (an HMAC, Day 25); you recompute and compare.
2. **Respond fast.** Return `2xx` within a few seconds, and do the heavy work in a background queue (Day 34).
3. **Expect retries and duplicates.** If you time out, the provider retries, often for hours or days with backoff. So the same event can arrive twice: store processed event IDs and skip repeats (idempotency, Day 43).
4. **Expect any order.** "refunded" may arrive before "succeeded".

## Choosing

| | Direction | Latency | Server cost | Best for |
|---|---|---|---|---|
| Short polling | client asks | up to interval | many wasted requests | rare updates, simplest setup |
| Long polling | client asks, server waits | low | one parked request per user | fallback when WS blocked |
| SSE | server → client | low | one open connection per user | feeds, notifications, AI streaming |
| WebSocket | both ways | lowest | one open connection per user, stateful | chat, games, collaboration |
| Webhook | server → server | low | a request per event | integrations (payments, GitHub) |

Rule of thumb: **need the client to talk back often? WebSocket. Only server pushes? SSE. Machines notifying machines? Webhooks.**

## Holding millions of connections

An open connection mostly sits idle, so the question isn't CPU but **memory and file descriptors**. In Linux every socket is a file descriptor (Day 6), and the per-process limit (`ulimit -n`) often defaults to 1024, so it must be raised.

A common myth: "a server can only have 65,535 connections because there are 65,535 ports." A TCP connection is identified by the 4-tuple *(client IP, client port, server IP, server port)*. All clients connect to the same server port 443, but each tuple is different, so one server can hold far more. The port limit bites the *client* side (e.g. a proxy opening many connections to one backend).

```text
Memory per idle WebSocket ~ 10-50 KB (kernel buffers + app objects)
  1,000,000 connections x 20 KB = 20 GB of RAM

Chat app with 10,000,000 concurrent users
  if one gateway server comfortably holds 100,000 connections
  servers = 10,000,000 / 100,000 = 100 gateway servers (+ headroom, say 130)
```

With an event loop (Node, Go, Netty; see Day 9) you don't need a thread per connection, which is what makes 100k+ per box realistic.

### The architecture

```text
 phones/browsers
   |   |   |
 [ load balancer ]  (must allow Upgrade and long idle timeouts)
   |        |
[gateway A] [gateway B] ...  each holds many WebSocket connections
   \        /
  [ pub/sub backplane, e.g. Redis or Kafka ]
         |
  [ chat service + database ]
```

Alice is connected to gateway A and Bob to gateway B. When Alice sends a message, gateway A can't write to Bob's socket. It publishes to a channel; gateway B is subscribed and delivers it. A small **connection registry** ("user 42 is on gateway B") lets you route directly instead of broadcasting.

### Keeping connections alive

- **Heartbeats:** send a ping every 20–30 s. Load balancers and NAT routers (Day 11) silently drop connections that look idle (AWS's Application Load Balancer default idle timeout is 60 s).
- **Reconnect with jitter:** if a gateway restarts, 100,000 clients reconnect at once. Random delays (Day 43) stop a "thundering herd".
- **Resume:** on reconnect the client sends the last message ID it saw, and the server replays from there.
- **Deploys:** draining a gateway means closing its connections gracefully, a few at a time.

## In an interview

This shows up in "design a chat app" (Day 58), "live notifications" (Day 61), "ride tracking" (Day 63), "collaborative docs" (Day 64). Interviewers listen for: you pick the technique with a reason, you know WebSockets are stateful and what that does to load balancing, and you can size the gateway fleet.

> "For chat I'd use WebSockets because both sides send frequently and we want sub-second delivery. Clients connect through an L7 load balancer to a fleet of stateless-ish gateway servers that only hold connections; message logic lives behind them. Gateways publish to and subscribe from a pub/sub layer, with a registry mapping user to gateway. With 10M concurrent users at ~100k connections per box we need about 100 gateways plus headroom. Clients send heartbeats every 30 s, reconnect with jittered backoff and resume from their last message ID. If WebSockets are blocked we fall back to long polling."

## Common mistakes

- **"WebSockets are always best."** For one-way updates SSE is simpler, works with ordinary HTTP infrastructure and reconnects by itself.
- **Forgetting the connection is stateful.** Round-robin routing doesn't help a message reach a socket on another server: you need pub/sub or a registry.
- **Assuming delivery.** A socket write can succeed and the phone can still lose signal. Real apps use message IDs and acknowledgements.
- **Doing slow work inside a webhook handler.** Acknowledge quickly, process in a queue, de-duplicate.
- **Believing the 65,535-port limit applies to a server's incoming connections.**

## Before moving on

- [ ] I can explain why plain HTTP can't push and list five workarounds
- [ ] I can compute the request rate of polling for N users every T seconds
- [ ] I can describe the WebSocket upgrade handshake and the `101` status
- [ ] I know when SSE beats WebSockets
- [ ] I can list four things a webhook receiver must do
- [ ] I can sketch a gateway + pub/sub architecture and size it

## Go deeper (optional)

- [MDN: Server-sent events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events)
- [MDN: The WebSocket API](https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API)
- [RFC 6455: The WebSocket Protocol](https://www.rfc-editor.org/rfc/rfc6455)
- [Wikipedia: Webhook](https://en.wikipedia.org/wiki/Webhook)
