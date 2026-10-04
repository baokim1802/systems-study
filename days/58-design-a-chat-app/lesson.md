# Design a Chat App

> WhatsApp, Messenger and Slack feel simple: type, press send, a tick appears. Underneath sits one of the best interview questions there is, because it touches long-lived connections, ordering, delivery guarantees, presence and offline devices all at once.

## The big idea

Think of a post office that also runs a phone line to every house. When you're home (online), the clerk calls you the moment a letter for you arrives and reads it out. When you're out (offline), the letter waits in your **mailbox**, and the clerk leaves a sticky note on your door (a **push notification**). When you come back, you open the mailbox and read everything since the last letter you read.

That is the whole design:

- the **phone line** is a WebSocket connection (Day 18) that stays open while the app is open,
- the **mailbox** is durable message storage, read from a per-device cursor,
- the **sticky note** is a push notification through Apple's or Google's push service.

We'll follow the 7-step framework from Day 55.

## Step 1: Clarify requirements

**Functional**

- 1:1 chat and group chat (cap groups at, say, 1,000 members).
- Text messages (media goes to object storage, Day 36; the message holds a link).
- Delivery receipts: sent ✓, delivered ✓✓, read (blue).
- Presence: "online" / "last seen".
- Offline users get a push notification and see history when they return.
- Multiple devices per user (phone + laptop).

**Non-functional**

- Low latency: an online recipient sees the message in well under a second (target p99 < 500 ms).
- **Never lose a message** once the sender saw ✓.
- Messages in one conversation appear **in the same order for everyone**.
- Highly available; a crashed server must not lose chats.

Out of scope (say so out loud): end-to-end encryption details, voice/video calls, search.

## Step 2: Back-of-the-envelope estimates

Assume **500M daily active users**, each sending **40 messages/day**.

```text
Messages/day   = 500M × 40              = 20 billion
Average rate   = 20e9 / 86,400 s        ≈ 231,000 msg/s
Peak (×3)                               ≈ 700,000 msg/s

Message size   ≈ 100 B text + ~100 B metadata (ids, timestamps) = 200 B
Storage/day    = 20e9 × 200 B           = 4 TB/day
Storage/year   = 4 TB × 365             ≈ 1.5 PB/year  (before replication ×3)

Concurrent connections at peak: say 40% of DAU online = 200M open sockets
```

How many gateway servers hold those sockets? An idle WebSocket costs mostly memory (tens of KB per connection for buffers and state). A well-tuned server can hold **hundreds of thousands** of connections; WhatsApp famously reported around 2 million per server on Erlang. Planning conservatively at **100k per server**:

```text
200M connections / 100k per server = 2,000 gateway servers
```

That number tells the interviewer you understand the real bottleneck: **connections**, not bytes. 700k msg/s × 200 B is only 140 MB/s of payload.

## Step 3: API

Two channels. Real-time traffic flows over the WebSocket as small JSON (or protobuf) frames:

```text
client → server  { type: "send", clientMsgId: "c-81f2", convId: "g42", body: "hi" }
server → client  { type: "ack",  clientMsgId: "c-81f2", msgId: "m-9001", seq: 1047 }
server → client  { type: "msg",  convId: "g42", seq: 1047, from: "u7", body: "hi", ts: ... }
client → server  { type: "receipt", convId: "g42", upToSeq: 1047, kind: "read" }
```

Everything that is not real-time is plain REST (Day 17):

```text
GET  /v1/conversations?updatedSince=...            list my chats
GET  /v1/conversations/{id}/messages?beforeSeq=1047&limit=50   history (cursor pagination)
POST /v1/media/upload-url                           presigned upload URL (Day 36)
```

`clientMsgId` is the client's own random ID. It is an **idempotency key** (Day 43): if the phone retries a send, the server recognizes the duplicate.

## Step 4: Data model

The dominant access pattern is "give me the latest 50 messages of conversation X, then the 50 before that". So partition by conversation and sort by sequence number. A wide-column store such as Cassandra (Day 23) fits perfectly:

```text
messages        PARTITION KEY conv_id, CLUSTERING KEY seq DESC
                (conv_id, seq, msg_id, sender_id, body, created_at)

conversations   (conv_id, type: direct|group, name, last_seq)
members         (conv_id, user_id, role, joined_at)
user_convs      (user_id, conv_id, last_read_seq, muted)       ← "my chat list"
device_cursors  (device_id, conv_id, delivered_seq)
```

One partition per conversation keeps reads to a single node. A huge, ancient group could make a partition too big, so production systems also bucket by time (`conv_id + month`).

## Step 5: High-level design

```text
 phone / laptop
      │  WebSocket (TLS)
      ▼
┌─────────────┐     ┌──────────────────────┐
│ L4 load     │────▶│ Gateway servers      │  hold sockets, no business logic
│ balancer    │     │ (2,000 of them)      │
└─────────────┘     └──────────┬───────────┘
                               │ internal RPC
                               ▼
                      ┌──────────────────┐     ┌────────────────────┐
                      │ Chat service     │────▶│ Message store      │
                      │ assigns seq,     │     │ (Cassandra-like)   │
                      │ persists, routes │     └────────────────────┘
                      └──┬──────────┬────┘
           who is where? │          │ recipient offline
                         ▼          ▼
              ┌───────────────┐  ┌────────────────┐    ┌──────────────┐
              │ Session store │  │ Push service   │───▶│ APNs / FCM   │
              │ user→gateway  │  │ (Day 61)       │    └──────────────┘
              │ (Redis)       │  └────────────────┘
              └───────────────┘
              ┌───────────────┐
              │ Presence svc  │  heartbeats, last-seen
              └───────────────┘
```

The life of one message from Alice to Bob:

1. Alice's phone sends `{send, clientMsgId}` over its socket to gateway G1.
2. G1 forwards to the chat service, which checks the idempotency key, assigns the next `seq` for the conversation, and **writes to the message store**.
3. Only after the write succeeds does Alice get `ack` → she sees ✓. This is the durability promise.
4. The chat service looks up Bob's devices in the session store: Bob's phone is on gateway G7.
5. It sends the message to G7, which pushes it down Bob's socket. Bob's phone replies with a delivery receipt → Alice sees ✓✓.
6. If Bob has no live connection, the push service sends a notification instead. When Bob opens the app, it asks "everything after `delivered_seq`" and catches up.

Gateways are deliberately dumb. Keeping logic out of them means you can deploy the chat service many times a day without dropping 200M sockets.

## Step 6: Deep dives

### Ordering: sequence numbers, not clocks

Phone clocks are wrong and server clocks drift (Day 41), so timestamps can't define order. Instead, **one owner per conversation hands out increasing sequence numbers**: 1046, 1047, 1048. Route each conversation to one chat-service instance (consistent hashing on `conv_id`, Day 33), or use an atomic counter (`INCR` in Redis, or a conditional write on `last_seq`). Every client sorts by `seq`, so everyone sees the same order.

A gap tells the client something is missing. Here's the receiving-side logic:

```js
// Deliver messages in seq order; report gaps so the client can fetch them over REST.
function makeReceiver(lastSeq) {
  const buffer = new Map();               // seq → message, arrived early
  return function receive(msg) {
    if (msg.seq <= lastSeq) return { show: [], missing: [] };   // duplicate: drop it
    buffer.set(msg.seq, msg);
    const show = [];
    while (buffer.has(lastSeq + 1)) {     // release everything now contiguous
      show.push(buffer.get(lastSeq + 1));
      buffer.delete(++lastSeq);
    }
    const missing = [];
    const maxSeen = Math.max(lastSeq, ...buffer.keys());
    for (let s = lastSeq + 1; s < maxSeen; s++) if (!buffer.has(s)) missing.push(s);
    return { show, missing };
  };
}

const rx = makeReceiver(10);
console.log(rx({ seq: 12, body: "b" }));  // { show: [], missing: [11] }
console.log(rx({ seq: 11, body: "a" }));  // { show: [a, b], missing: [] }
console.log(rx({ seq: 11, body: "a" }));  // duplicate → nothing
```

### Delivery guarantees

Networks drop things, so every hop uses **at-least-once delivery plus dedup** (Day 43): the sender retries until acked; the server dedups by `clientMsgId`; the receiver dedups by `seq`. Together that behaves like "exactly once" from the user's point of view.

### Receipts

Don't send one receipt per message. Send a **watermark**: "delivered up to seq 1047", "read up to seq 1040". One small frame covers a burst of 30 messages. In a 1,000-person group, per-member read receipts would mean up to 1,000 events per message, so big groups usually show only aggregate counts or "seen by" on demand.

### Presence

Each client sends a heartbeat every ~30 s; if none arrives for ~60 s, the user is offline and `last_seen` is stored. The expensive part is **fan-out**: a user with 500 contacts going online can't trigger 500 pushes every time their train enters a tunnel. Fixes: only push presence to contacts who currently have your chat open, otherwise fetch lazily when a chat opens; and debounce flapping.

### Group chat

Store the message **once** in the group's partition (not 1,000 copies). Then fan out a lightweight "new message in g42, seq 1047" to members' online devices via the session store. Offline members simply catch up from their cursor later. That's fan-out-on-read for storage plus fan-out-on-write for notifications, the same trade-off you met with news feeds on Day 57.

## Step 7: Bottlenecks and trade-offs

- **Gateway crash:** 100k phones lose their socket at once and reconnect together. Use exponential backoff with jitter (Day 43) on the client so the reconnect storm is spread out, and keep gateways stateless so any one can take them.
- **Hot group:** a 1,000-member group with 50 msg/s means 50,000 deliveries/s from one conversation owner; batch deliveries per gateway.
- **Multi-region:** users connect to the nearest region; a conversation lives in one home region, and cross-region messages hop once over the backbone.
- **Storage growth:** 1.5 PB/year; move old partitions to cheaper storage tiers.

## In an interview

Interviewers listen for: WebSockets (with why), a clear durable-before-ack rule, per-conversation sequence numbers, idempotent retries, how offline users catch up, and connection-count math. A strong one-paragraph summary:

> "Clients keep a WebSocket to a stateless gateway tier. Sends go to a chat service that dedups by client message ID, assigns a per-conversation sequence number, and persists to a store partitioned by conversation before acking. It then looks up recipients' gateways in a session store and pushes; offline devices get an APNs/FCM notification and later sync everything after their cursor. Delivery is at-least-once with dedup at both ends, receipts are watermarks, and the main scaling problem is ~200M concurrent connections, so ~2,000 gateways."

## Common mistakes

- **Ordering by timestamp.** Clocks disagree; use a sequence number from one owner per conversation.
- **Acking before persisting.** If the server crashes, the message is gone but the sender saw ✓.
- **Putting logic in the gateways.** Then every deploy disconnects everyone.
- **Copying each group message into every member's inbox.** 1,000× storage for nothing; store once, keep cursors.
- **Forgetting multiple devices.** Cursors and push targets are per *device*, not per user.

## Before moving on

- [ ] I can explain why chat uses WebSockets and what the gateway tier does
- [ ] I can estimate connections and gateway count from DAU
- [ ] I can describe how one message travels from sender to an online and an offline recipient
- [ ] I can explain sequence numbers, idempotency keys and watermark receipts
- [ ] I can name two problems with presence and group chat at scale and a fix for each

## Go deeper (optional)

- [WebSocket on MDN](https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API)
- [XMPP on Wikipedia](https://en.wikipedia.org/wiki/XMPP), the protocol early WhatsApp was built on
- *Designing Data-Intensive Applications* by Martin Kleppmann, chapters 5 (replication) and 11 (stream processing)
