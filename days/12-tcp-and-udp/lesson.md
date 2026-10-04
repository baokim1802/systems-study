# TCP and UDP

> IP delivers packets on a "best effort" basis: they can be lost, duplicated or arrive out of order. TCP turns that chaos into a reliable, ordered stream; UDP deliberately doesn't. Picking between them, and knowing what TCP costs, shapes the latency of every system you'll design.

## The big idea

Yesterday's postcards (packets) can get lost or shuffled. Two ways to send something:

- **TCP is a phone call with a careful note-taker.** First you dial and both sides say "hello?" "hello!" so you know the line works. Then every sentence is numbered; the listener says "got up to sentence 42". If they miss one, you repeat it. If they say "slow down", you slow down. Everything arrives, in order, or you find out the call dropped.
- **UDP is throwing postcards into the mailbox.** No setup, no confirmation, no ordering. Each postcard is on its own. Cheap and instant, but if one is lost, nobody tells you.

Both sit at the **transport layer** (layer 4) on top of IP, and both use **ports** to deliver data to the right program.

## TCP: the three-way handshake

Before any data, TCP opens a **connection** with a three-way handshake. Each side picks a random starting **sequence number** (a counter for bytes it will send).

```text
 Client                                         Server (listening on :443)
   |  --- SYN, seq=1000 ---------------------->  |   "I'd like to talk; my bytes start at 1000"
   |  <-- SYN-ACK, seq=5000, ack=1001 --------   |   "OK; mine start at 5000; I expect your 1001 next"
   |  --- ACK, ack=5001 ---------------------->  |   "Great, I expect your 5001 next"
   |  --- data (HTTP request) ---------------->  |   data can ride with/right after the final ACK
```

**Cost: one full round trip (1 RTT) before the client can send its request.** If the server is 80 ms away, that's 80 ms of nothing but "hello". This is why connection reuse matters so much (keep-alive, connection pools, Day 14 and Day 16).

Why three steps and not two? Each side has to *announce* its starting sequence number and *hear confirmation* that the other got it. The middle packet combines the server's announcement and its confirmation, so it's three messages. Random starting numbers also make it hard for an attacker to inject fake packets, and keep old delayed packets from a previous connection from being mistaken for new ones.

Closing uses `FIN` packets (each side closes its direction), and an abrupt kill uses `RST`. After closing, the side that closed first sits in `TIME_WAIT` for a while (often 60 s on Linux) to absorb stray late packets, which is why a busy server opening many short-lived outbound connections can run out of ephemeral ports.

## How TCP makes delivery reliable

1. **Sequence numbers** label every byte. The receiver can put out-of-order segments back in order and drop duplicates.
2. **Acknowledgments (ACKs)** tell the sender "I've received everything up to byte N".
3. **Retransmission.** If no ACK arrives within a **retransmission timeout** (computed from measured RTT), or the sender gets three duplicate ACKs (a hint that one segment is missing while later ones arrived), it resends.
4. **Checksums** catch corrupted segments, which are dropped and later resent.

```text
 Sender sends segments 1,2,3,4,5      Receiver gets 1,2,_,4,5
 Receiver ACKs: "up to 2", "up to 2", "up to 2"  (duplicate ACKs)
 Sender: three dup ACKs → resend 3 right away ("fast retransmit")
 Receiver now has 1–5 → ACK "up to 5", delivers 3,4,5 to the app in order
```

To the application, TCP looks like a **byte stream**: you `write` bytes on one end and `read` the same bytes in the same order on the other. It has **no message boundaries**: two writes of 100 bytes might be read as one 200-byte chunk, or as 150 + 50. Protocols on top (HTTP, Redis, databases) add their own framing, like length prefixes or `\r\n` delimiters.

## Flow control vs congestion control

Two different "slow down" mechanisms. Interviewers love asking for the difference.

| | Flow control | Congestion control |
|---|---|---|
| Protects | The **receiver** (its buffer) | The **network** (routers in between) |
| Signal | Receiver advertises a **window**: "I have 64 KB free" | Inferred from **packet loss** (or rising delay) |
| Mechanism | Sender never has more unACKed data in flight than the receive window | Sender keeps a **congestion window (cwnd)** and adjusts it |

**Congestion control** in more detail. The sender can have at most `min(cwnd, receive window)` bytes "in flight" (sent but not yet ACKed).

- **Slow start:** a new connection starts with a small cwnd (commonly 10 segments ≈ 14.6 KB on Linux) and **doubles it every RTT** while all is well. "Slow" is ironic; it's exponential.
- **Congestion avoidance:** after a threshold, grow by about one segment per RTT (linear).
- **On loss:** assume the network is overloaded and cut cwnd (classic algorithms halve it). This is **AIMD**: additive increase, multiplicative decrease. Modern algorithms like CUBIC (Linux default) and Google's BBR refine this.

## The math: slow start and throughput

**How many round trips to send a 500 KB response on a fresh connection?** Assume 1,460-byte segments, initial cwnd = 10, doubling each RTT, no loss.

```text
RTT 1:  10 segments   → total 10
RTT 2:  20            → total 30
RTT 3:  40            → total 70
RTT 4:  80            → total 150
RTT 5: 160            → total 310
500 KB / 1,460 B ≈ 343 segments → needs a 6th round trip.
```

So ~6 RTTs of data transfer, plus 1 RTT handshake (plus TLS, Day 15). At 100 ms RTT that's about 700 ms, even on a gigabit link. On a fresh connection, **latency, not bandwidth, limits small-to-medium transfers**. This is why keeping connections warm and reusing them is a big deal.

**The throughput ceiling:** one TCP connection can't go faster than `window / RTT`.

```text
window 64 KB, RTT 100 ms:  65,536 B / 0.1 s ≈ 655 KB/s ≈ 5.2 Mbit/s
```

A transatlantic transfer with a small window crawls no matter how fat the pipe. Modern stacks use **window scaling** to allow windows of many MB. The amount you need to fill the pipe is the **bandwidth-delay product**: `1 Gbit/s × 0.1 s = 100 Mbit = 12.5 MB` in flight.

## Head-of-line blocking

Because TCP delivers bytes **strictly in order**, a single lost packet stalls everything behind it, even data that already arrived. Like a checkout line where one customer's card is declined: everyone waits.

```text
 Arrived:  [1][2][ ][4][5][6]     ← 3 lost
 App sees: 1, 2 ... (waits ~1 RTT for 3's retransmission) ... 3, 4, 5, 6
```

This matters for HTTP/2 (Day 14): it multiplexes many requests over one TCP connection, so one lost packet stalls *all* of them. HTTP/3 fixes this by running over **QUIC**, which is built on UDP and tracks each stream separately.

## UDP: just send it

UDP adds almost nothing to IP: source port, destination port, length and checksum. **An 8-byte header** (TCP's is at least 20). No handshake, no ACKs, no retransmission, no ordering, no congestion control. Each **datagram** is a self-contained message with its boundaries preserved.

```js
// Node: a UDP echo server and client
const dgram = require("dgram");
const server = dgram.createSocket("udp4");
server.on("message", (msg, rinfo) => {
  console.log(`got "${msg}" from ${rinfo.address}:${rinfo.port}`);
  server.send(`echo: ${msg}`, rinfo.port, rinfo.address);
});
server.bind(41234);

const client = dgram.createSocket("udp4");
client.on("message", msg => { console.log(String(msg)); client.close(); server.close(); });
client.send("hello", 41234, "127.0.0.1"); // no connect, no handshake: just send
```

Why would anyone want unreliability? Because sometimes **late data is worthless**:

- **Voice/video calls, game state:** if a frame from 200 ms ago is lost, resending it is pointless; the next frame is already here. Waiting would freeze everything (head-of-line blocking).
- **DNS lookups:** one small question, one small answer. A handshake would double the cost. If no answer, just ask again.
- **Building your own protocol:** QUIC (HTTP/3), WebRTC and many game engines use UDP and add exactly the reliability they want on top.
- **Metrics/logging fire-and-forget** (e.g. StatsD): losing a few samples is fine.

## TCP vs UDP side by side

| | TCP | UDP |
|---|---|---|
| Connection | Yes, 3-way handshake (1 RTT) | No |
| Reliability | Retransmits lost data | None |
| Ordering | Guaranteed | None |
| Boundaries | Byte stream (no message boundaries) | Datagrams (boundaries kept) |
| Congestion control | Yes | No (app must behave) |
| Header | 20–60 bytes | 8 bytes |
| Used by | HTTP/1.1, HTTP/2, SSH, databases, email | DNS, video/voice, games, QUIC/HTTP/3 |

## In an interview

It comes up as: "TCP or UDP for X?" (live video, multiplayer game, file transfer, chat), "why is the first request slow?", "what's head-of-line blocking?", "why does HTTP/3 use UDP?".

A strong answer: *"TCP gives a reliable, ordered byte stream: a 3-way handshake costing one RTT, sequence numbers, ACKs and retransmissions, plus flow control to protect the receiver and congestion control (slow start, AIMD) to protect the network. The price is setup latency and head-of-line blocking: one lost packet stalls everything behind it. UDP is a thin wrapper over IP with no guarantees, which is what you want when stale data is useless, like real-time voice or game state, or when you want to build your own reliability, like QUIC. For a chat app I'd use TCP-based WebSockets because every message must arrive in order; for a voice channel I'd use UDP via WebRTC."*

## Common mistakes

- **"UDP is faster."** It has less setup and no retransmission waits, but the bits travel at the same speed. On a clean network the difference is mostly the handshake and head-of-line stalls.
- **"TCP guarantees delivery."** It guarantees in-order delivery *or an error*. If the network is down, the connection eventually times out; your app must handle that (Day 43, retries).
- **"One `send` = one `receive`."** Not in TCP. It's a stream; you need framing.
- **Confusing flow control (receiver) with congestion control (network).**
- **"UDP has no ports / no checksum."** It has both. It lacks connections, ordering and retransmission.

## Before moving on

- [ ] I can draw the three-way handshake and say what it costs
- [ ] I can explain sequence numbers, ACKs and retransmission in two sentences
- [ ] I can tell flow control from congestion control
- [ ] I can explain head-of-line blocking and why HTTP/3 moved to UDP
- [ ] I can pick TCP or UDP for a use case and justify it

## Go deeper (optional)

- [Wikipedia: Transmission Control Protocol](https://en.wikipedia.org/wiki/Transmission_Control_Protocol)
- [Wikipedia: User Datagram Protocol](https://en.wikipedia.org/wiki/User_Datagram_Protocol)
- *High Performance Browser Networking* by Ilya Grigorik (free online), chapters on TCP and UDP
- [RFC 9293: TCP](https://www.rfc-editor.org/rfc/rfc9293)
