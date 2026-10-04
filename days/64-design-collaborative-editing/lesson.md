# Design Collaborative Editing

> In Google Docs, five people can type in the same paragraph at once and everyone ends up with the same text, with nobody's words lost. That feels like magic until you try to build it. This design is about one deep problem (merging concurrent edits) wrapped in a familiar real-time architecture.

## The big idea

Imagine two people editing the same paper copy of a recipe, in different rooms, phoning each other their changes. Alice says "insert 'very ' at position 10." Meanwhile Bob deleted the first word, so for him position 10 is now a different spot. If Bob blindly applies "position 10", the word lands in the wrong place. The fix is to **adjust** the instruction: "Alice's position 10 is my position 4, because I deleted 6 characters before it."

That adjustment is the heart of **Operational Transformation (OT)**. The other family of solutions, **CRDTs** (Conflict-free Replicated Data Types), avoids positions altogether: every character gets a permanent unique ID, so "insert after character `alice:17`" means the same thing on every copy, no matter what else happened.

Why not simpler ideas?

- **Lock the document** (one editor at a time): kills the whole point of collaboration.
- **Last write wins** on the whole document: Bob's save erases Alice's paragraph.
- **Send raw positions without adjusting**: copies diverge, and people see different documents.

## Step 1: Clarify requirements

**Functional**

- Many users edit the same rich-text document at the same time.
- Each sees others' changes within a fraction of a second, plus their **cursors and selections** (presence).
- Your own typing appears **instantly**, never waiting for the server.
- Offline editing that merges when you reconnect.
- Version history: see and restore earlier versions.

**Non-functional**

- **Convergence:** once everyone has received all edits, every copy is identical.
- **Intention preservation:** an edit lands where its author meant it.
- No lost edits, even if a server crashes.
- Remote edits visible in under ~200 ms.

## Step 2: Back-of-the-envelope estimates

```text
DAU                          10M
Peak concurrent editors      1M; 20% typing at any instant = 200k typists
Typing speed                 ~5 characters/s → 200k × 5 = 1M ops/s at peak
Average collaborators/doc    ~2, so fan-out adds ~1M outgoing messages/s
Op size                      ~50 B (type, position or id, char, revision, user)
Ingest                       1M × 50 B = 50 MB/s at peak
Op log per day (avg ≈ 30% of peak)  1M × 0.3 × 86,400 × 50 B ≈ 1.3 TB/day
```

The op log grows fast, so we periodically write a **snapshot** (the full document at revision N) and compact old ops. Most documents are small (tens of KB), so a whole active document fits in one server's memory.

The hard case is one hot document: a 50-person meeting doc where each person types 5 ops/s receives 250 ops/s and must send each to 49 others: **12,250 messages/s** from one server for one doc. That's why we batch ops (send every 50–100 ms) and throttle cursor updates.

## Step 3: API

```text
REST
  GET  /v1/docs/{id}                     → { snapshot, revision }   initial load
  GET  /v1/docs/{id}/history?before=...  versions
WebSocket /v1/docs/{id}/live
  client → server  { type: "ops", baseRev: 1041, ops: [...], clientSeq: 7 }
  server → client  { type: "ack", clientSeq: 7, rev: 1043 }
  server → client  { type: "ops", rev: 1042, ops: [...], author: "u_bob" }
  both ways        { type: "presence", cursor: 120, selection: [120, 128] }
```

`baseRev` tells the server which version the client's ops were made against, so it knows which concurrent ops to transform them over.

## Step 4: Data model

```text
documents  (doc_id, title, owner_id, latest_rev, latest_snapshot_rev, acl)
ops        (doc_id, rev, author, ops_blob, created_at)   PK (doc_id, rev), append-only
snapshots  (doc_id, rev, storage_key)                     full doc every ~1,000 ops
presence   in memory only (ephemeral; never stored)
```

Loading a doc = latest snapshot + replay ops after it. Version history = pick a snapshot and replay up to any revision.

## Step 5: High-level design

```text
 Alice ─┐                         ┌──────────────────────────────────────┐
 Bob   ─┼─WebSocket─▶ gateways ──▶│ Doc session server (owner of doc 42) │
 Carol ─┘   (route by doc_id,     │  in-memory doc + revision counter    │
            consistent hashing)   │  transform → apply → persist → fan out│
                                  └──────┬────────────────────┬──────────┘
                                         │ append op            │ every ~1,000 ops
                                         ▼                      ▼
                                  op log (DB / Kafka)    snapshots (object storage)
            ownership leases ◀── coordination service (etcd / ZooKeeper, Day 42)
```

Every edit of document 42 flows through **one owner process**. Routing by `doc_id` with consistent hashing (Day 33) sends all of a document's sockets to the same server. A single owner gives a single, total order of operations (revision 1041, 1042, …), which makes OT much simpler.

## Step 6: Deep dives

### OT step by step

Document `"abc"`. Concurrently:

- Alice: insert `"X"` at 0 → she sees `"Xabc"`.
- Bob: delete position 2 (the `"c"`) → he sees `"ab"`.

The server receives Alice's op first and applies it: `"Xabc"`. Now Bob's op arrives, made against the old version. Applied raw, "delete at 2" would delete `"b"`. Wrong! Transform it against Alice's insert: the insert happened before position 2, so shift right by one → delete at 3 → `"Xab"`. Meanwhile Bob receives Alice's insert; transformed against his delete (which was *after* position 0), it stays at 0: `"ab"` → `"Xab"`. Both converge to `"Xab"`.

```js
// Single-character ops: { type: "ins", pos, ch, site } or { type: "del", pos }.
// transform(a, b) returns a version of a that applies AFTER b has been applied.
function transform(a, b) {
  if (a === null || b === null) return a;
  const shift = (op, d) => ({ ...op, pos: op.pos + d });
  if (a.type === "ins" && b.type === "ins") {
    const aFirst = a.pos < b.pos || (a.pos === b.pos && a.site < b.site); // tie-break
    return aFirst ? a : shift(a, 1);
  }
  if (a.type === "ins" && b.type === "del") return a.pos <= b.pos ? a : shift(a, -1);
  if (a.type === "del" && b.type === "ins") return a.pos < b.pos ? a : shift(a, 1);
  if (a.pos === b.pos) return null;            // both deleted the same char: nothing left to do
  return a.pos < b.pos ? a : shift(a, -1);
}

function apply(doc, op) {
  if (op === null) return doc;
  return op.type === "ins"
    ? doc.slice(0, op.pos) + op.ch + doc.slice(op.pos)
    : doc.slice(0, op.pos) + doc.slice(op.pos + 1);
}

const alice = { type: "ins", pos: 0, ch: "X", site: "alice" };
const bob = { type: "del", pos: 2 };
const atServer = apply(apply("abc", alice), transform(bob, alice));
const atBob = apply(apply("abc", bob), transform(alice, bob));
console.log(atServer, atBob); // "Xab" "Xab"  → converged
```

The **tie-break** (`site` comparison) matters: if Alice and Bob both insert at position 0, every copy must agree on whose character comes first, or they diverge.

Real OT handles strings, formatting and rich structure, and the number of op-type pairs grows quickly. That's why OT is famously hard to get fully correct, and why systems like Google Docs pair it with a central server: with a single total order you only ever transform a client's op against the server ops it hasn't seen.

### Optimistic local edits

The client applies your keystroke immediately, sends it, and keeps it in a **pending** list. When remote ops arrive, the client transforms them against its pending ops before applying them. When the server acks, the op leaves the pending list. So typing never waits for a round trip.

### CRDTs: the other approach

A text CRDT gives every character a **unique, immutable ID** like `(site, counter)` and stores "this character comes after character X." Inserting means "put `"k"` after `alice:17`." Deleting marks a character as a **tombstone** rather than removing it, so later ops can still refer to it. Because IDs never shift, operations **commute**: apply them in any order and you get the same result. No central server is required.

| | OT | CRDT |
|---|---|---|
| Positions | integer indexes, transformed | stable unique IDs |
| Needs a central order? | practically yes | no (works peer-to-peer) |
| Offline / P2P | harder | natural fit |
| Metadata overhead | small | IDs per character + tombstones (needs garbage collection) |
| Used by | Google Docs | Yjs, Automerge; Figma uses a CRDT-inspired model with a server |

In an interview, a good answer is: "Central server + OT is the proven Google Docs approach; CRDTs shine for offline-first and peer-to-peer, at the cost of metadata."

### Presence (cursors)

Cursors change constantly but don't matter later, so they're **ephemeral**: kept in memory, never written to the op log, throttled to ~10 updates/s, and dropped when a user disconnects. A remote cursor's position must also be transformed by incoming ops, or it will drift.

### Durability and server failure

The owner **appends each op to the log before acking** the author (same rule as chat on Day 58). If the owner dies, the coordination service's lease expires (a few seconds), a new server takes ownership, loads the latest snapshot and replays the log to the latest revision. Clients reconnect and resend unacked ops with their `baseRev`; the new owner transforms them over anything newer. Leases plus **fencing tokens** stop a paused old owner from writing after it lost ownership (Day 42).

### Offline editing

The client keeps a queue of local ops while offline. On reconnect it sends them with the old `baseRev`; the server transforms them over everything that happened in between (could be thousands of ops: it works, but conflicts may look surprising to humans, like two people rewriting the same sentence). CRDT-based editors handle long offline periods more naturally, which is why offline-first apps often choose them.

## Step 7: Bottlenecks and trade-offs

- **Single owner per document:** simple ordering, but a hot doc is limited by one server; fine because a document's edit rate is bounded by how fast humans type.
- **Batching ops** (every 50–100 ms) cuts messages a lot at the cost of slight remote delay.
- **Snapshot frequency:** more snapshots mean faster loads and recovery but more storage.
- **OT vs CRDT:** server dependency and simplicity of metadata vs offline/P2P strength.

## In an interview

Interviewers want to hear that you see the real problem (concurrent edits with shifting positions), know both OT and CRDTs at an intuitive level, and wrap them in a sound architecture: single owner per document, op log + snapshots, optimistic local edits, ephemeral presence. Model summary:

> "Each document is owned by one session server chosen by consistent hashing on doc ID; clients connect over WebSockets. Clients apply edits locally, send them with their base revision, and the server transforms them against newer ops (OT), assigns the next revision, appends to a durable log, acks and broadcasts. Snapshots every ~1,000 ops make loading and history cheap. Cursors are ephemeral and throttled. If the owner dies, a lease moves ownership and the new owner replays snapshot plus log. CRDTs are the alternative when offline or peer-to-peer editing matters most."

## Common mistakes

- **Last-write-wins on the whole document.** Edits silently disappear.
- **Forgetting the tie-break** for concurrent inserts at the same position.
- **Waiting for the server before showing a keystroke.** It feels broken at 100 ms.
- **Persisting cursors in the op log.** Huge volume, zero value later.
- **Acking before persisting the op.** A crash then loses acknowledged edits.

## Before moving on

- [ ] I can explain why positions break under concurrent edits, with an example
- [ ] I can transform an insert against a delete by hand and show convergence
- [ ] I can compare OT and CRDTs in a short table from memory
- [ ] I can describe the single-owner architecture and how it recovers from a crash
- [ ] I can explain how offline edits are merged

## Go deeper (optional)

- [Operational transformation on Wikipedia](https://en.wikipedia.org/wiki/Operational_transformation)
- [Conflict-free replicated data type on Wikipedia](https://en.wikipedia.org/wiki/Conflict-free_replicated_data_type)
- Shapiro et al., *Conflict-free Replicated Data Types* (2011)
- *Designing Data-Intensive Applications*, chapter 5, section on handling write conflicts
