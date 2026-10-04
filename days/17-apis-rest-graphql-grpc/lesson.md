# APIs: REST, GraphQL and gRPC

> An API is the contract between two programs: your frontend and your backend, your service and someone else's. Good APIs are boring, predictable and hard to misuse; bad ones haunt teams for years because you can't change them once clients depend on them. In system design interviews, "define the API" is one of the first steps.

## The big idea

An **API (Application Programming Interface)** is a **menu**. The restaurant (server) decides which dishes exist, what you can customize and what you get back. Customers (clients) don't walk into the kitchen; they order from the menu. Change the menu carelessly ("we renamed *pizza* to *flatbread*") and regulars' orders break.

Three popular menu styles:

- **REST:** a menu organized by **things** (resources). "Orders", "Users", "Products", and standard verbs to act on them.
- **GraphQL:** a **build-your-own-plate** menu. You write down exactly which fields you want from which related things, in one order.
- **gRPC:** a **kitchen intercom between staff**. Fast, compact, strictly defined calls like `GetUser(id)`, mostly used between your own services.

## REST: resources and verbs

**REST** (Representational State Transfer) builds on HTTP (Day 14). You model your domain as **resources** with URLs, and use HTTP methods as the verbs.

```text
GET    /users/42                 read user 42
GET    /users/42/orders          list user 42's orders
POST   /users/42/orders          create an order        → 201 Created, Location: /orders/9001
GET    /orders/9001              read one order
PATCH  /orders/9001              partially update        {"status": "cancelled"}
DELETE /orders/9001              delete                  → 204 No Content
```

Rules of thumb for good REST design:

- **Nouns in paths, verbs in methods.** `POST /orders`, not `POST /createOrder`. For actions that don't fit, a sub-resource is fine: `POST /orders/9001/refund`.
- **Plural collection names**, ids underneath: `/products/7`.
- **Meaningful status codes**: 201 on create, 404 when missing, 409 on conflicts, 422/400 on bad input, 429 when rate-limited (Day 35).
- **Consistent errors**, e.g. `{"error": {"code": "OUT_OF_STOCK", "message": "...", "requestId": "..."}}`.
- **Filtering and sorting** with query parameters: `GET /orders?status=shipped&sort=-createdAt`.
- **Idempotency keys** on POSTs that must not happen twice (payments): `Idempotency-Key: 6f1c...`. The server stores the key with the result and returns the same result on a retry (Day 43).
- **Stateless**: each request carries its own auth (token or cookie), so any server can handle it (Day 27).

## Pagination: never return "everything"

`GET /posts` on a table with 50 million rows must not return 50 million rows. Two main styles:

**Offset pagination:** `GET /posts?limit=20&offset=40` → `SELECT ... ORDER BY created_at DESC LIMIT 20 OFFSET 40`.

- Easy, lets you jump to page 37.
- **Slow deep down:** the database still walks and throws away the first `offset` rows. Page 50,000 at 20 per page = skipping 1,000,000 rows on every request.
- **Unstable:** if a new post is inserted while you page, everything shifts by one and you see a duplicate (or miss one).

**Cursor (keyset) pagination:** the server returns an opaque **cursor** pointing at the last item; the next request continues *after* it.

```text
GET /posts?limit=20
→ { "items": [...20 posts...], "nextCursor": "eyJ0IjoiMjAyNi0wOS0zMFQxMDowMDowMFoiLCJpZCI6OTkxfQ" }

GET /posts?limit=20&cursor=eyJ0Ijoi...
→ SELECT ... WHERE (created_at, id) < ('2026-09-30T10:00:00Z', 991)
            ORDER BY created_at DESC, id DESC LIMIT 20
```

With an index on `(created_at, id)` (Day 21), each page is an index seek, so page 50,000 costs the same as page 1, and inserts don't cause duplicates. You lose "jump to page 37", which feeds and infinite scroll don't need. Here's the idea in JS:

```js
const encode = obj => Buffer.from(JSON.stringify(obj)).toString("base64url");
const decode = str => JSON.parse(Buffer.from(str, "base64url").toString());

function pagePosts(posts, limit, cursor) {          // posts sorted newest first
  let start = 0;
  if (cursor) {
    const { t, id } = decode(cursor);
    start = posts.findIndex(p => p.createdAt < t || (p.createdAt === t && p.id < id));
    if (start === -1) start = posts.length;
  }
  const items = posts.slice(start, start + limit);
  const last = items[items.length - 1];
  const more = start + limit < posts.length;
  return { items, nextCursor: more ? encode({ t: last.createdAt, id: last.id }) : null };
}
```

(A real database uses the index instead of `findIndex`; the cursor shape is the same.) Including `id` as a tiebreaker matters: two posts can share a timestamp.

## Versioning: changing the menu without breaking customers

Mobile apps in users' pockets may be months old; partners' integrations may never be updated. So:

- **Additive changes are safe:** adding a new optional field or a new endpoint. Clients must ignore fields they don't know.
- **Breaking changes** need a new version: removing or renaming a field, changing a type (`price: 10` → `price: "10.00"`), changing meaning, making an optional input required.

Common ways to version:

| Style | Example | Notes |
|---|---|---|
| URL path | `/v1/orders`, `/v2/orders` | Most common and most visible; easy to route and cache |
| Header | `Accept: application/vnd.myapp.v2+json` | Cleaner URLs, harder to test in a browser |
| Date-based | `Stripe-Version: 2024-06-20` | Each account pinned to a version; server translates old ↔ new |

And a process: announce deprecation, monitor who still calls v1, give a timeline, then turn it off.

## GraphQL: ask for exactly what you need

Imagine a mobile screen showing a user's name, their last 3 orders, and each order's product names. With REST that might be `GET /users/42`, then `GET /users/42/orders?limit=3`, then `GET /products/...` for each order: several round trips (**under-fetching**), each returning fields you don't use (**over-fetching**). On a 200 ms mobile RTT, four sequential calls is nearly a second.

**GraphQL** (created at Facebook, open-sourced 2015) exposes **one endpoint** (`POST /graphql`) and a **typed schema**; the client sends a query describing the exact shape it wants:

```text
query {
  user(id: 42) {
    name
    orders(last: 3) {
      id
      total
      items { product { name } }
    }
  }
}
```

The response mirrors the query: `{"data": {"user": {"name": "Ada", "orders": [...]}}}`. One round trip, no wasted fields. Writes are **mutations**, live updates are **subscriptions**.

On the server, each field has a **resolver** function. The classic trap is the **N+1 problem**: resolving `product` separately for each of 30 items fires 30 database queries. The standard fix is **batching** (the DataLoader pattern: collect all product ids in one tick, fetch them in one `WHERE id IN (...)` query).

Trade-offs: HTTP caching is harder (everything is a POST to one URL, though persisted queries help), a malicious client can send a hugely nested, expensive query (you need depth/complexity limits and timeouts), and the server is more complex. GraphQL shines when **many different clients** (web, iOS, Android) need **different shapes** of richly related data.

## gRPC: fast, typed calls between services

**gRPC** (from Google, 2015) is **RPC** (remote procedure call): calling a function on another machine as if it were local. You define the contract in a `.proto` file using **Protocol Buffers (protobuf)**:

```text
syntax = "proto3";

service UserService {
  rpc GetUser (GetUserRequest) returns (User);
  rpc StreamUpdates (GetUserRequest) returns (stream User);   // server streaming
}

message GetUserRequest { int64 id = 1; }
message User {
  int64  id    = 1;
  string name  = 2;
  string email = 3;
}
```

A code generator produces client and server code in Go, Java, Python, Node and more, so both sides share one source of truth and type errors are caught at compile time. gRPC runs over **HTTP/2** (Day 14), so it gets multiplexing and supports **streaming** in either or both directions.

**Why protobuf is compact:** field names are never sent, only the field **numbers** and values, with integers in a variable-length encoding (**varint**: 7 bits per byte, the top bit says "more bytes follow").

```text
JSON:      {"id":150}                 → 10 bytes of text
Protobuf:  field 1, varint 150        → 08 96 01  = 3 bytes
           0x08  = (field number 1 << 3) | wire type 0 (varint)
           150   = 1001 0110 in binary → split into 7-bit groups
                   low group 001 0110 with "more" bit → 1001 0110 = 0x96
                   high group 000 0001               → 0000 0001 = 0x01
```

Those field numbers are also how protobuf evolves safely: **never reuse or change a field's number**; add new fields with new numbers, and old clients skip numbers they don't know.

Trade-offs: browsers can't speak gRPC natively (you need gRPC-Web and a proxy), payloads aren't human-readable (debug with tools like `grpcurl`), and you need the schema to decode a message.

## Choosing between them

| | REST (JSON) | GraphQL | gRPC |
|---|---|---|---|
| Best for | Public APIs, CRUD, simple web/mobile backends | Many clients needing different views of related data | Internal service-to-service calls, low latency, streaming |
| Transport | HTTP/1.1 or 2 | HTTP (one endpoint) | HTTP/2 |
| Format | JSON text | JSON text | Protobuf binary |
| Contract | OpenAPI (optional) | Schema (required) | `.proto` (required), code generation |
| HTTP caching | Excellent (GET + URLs) | Harder | Not applicable |
| Browser-friendly | Yes | Yes | Needs gRPC-Web proxy |
| Pitfalls | Over/under-fetching, chatty | N+1 queries, expensive queries | Tooling, binary debugging |

A very common real setup: **REST or GraphQL at the edge** for browsers, mobile apps and partners, and **gRPC between internal services**.

## The math: payloads and round trips

A mobile screen needs data from 4 REST endpoints, called **sequentially** because each needs an id from the previous; RTT is 150 ms; each response is 8 KB of JSON of which the screen uses about 2 KB.

```text
REST:     4 round trips × 150 ms = 600 ms network time;   32 KB downloaded
GraphQL:  1 round trip  × 150 ms = 150 ms (+ server fans out internally,
          where internal RTT is ~1 ms);                      ~2 KB downloaded
```

Same server work, 4× fewer round trips, about 16× fewer bytes. That's the argument for GraphQL or for a purpose-built "backend for frontend" REST endpoint.

## In an interview

In a design interview you'll write a few API endpoints early on. Interviewers look for: clear resources and methods, the important parameters, pagination on every list, idempotency for anything involving money or creation, and a sensible choice of style. For example, for a URL shortener (Day 56): `POST /v1/urls {longUrl, customAlias?} → 201 {shortUrl}` and `GET /{code} → 301/302 Location: longUrl`.

A good paragraph: *"Externally I'd expose a versioned REST API, `/v1/...`, with cursor pagination on list endpoints and an `Idempotency-Key` on POSTs that create orders. Internally, services talk gRPC for typed contracts, compact payloads and streaming. If we had several clients with very different screens, I'd consider GraphQL at the edge with DataLoader-style batching and query-cost limits."*

## Common mistakes

- **Verbs in URLs** (`/getUser`, `/deleteOrder?id=5`) and GET requests that change state.
- **Unbounded list endpoints.** Every list needs a limit and pagination.
- **Offset pagination for infinite feeds.** Use cursors: stable and constant-time.
- **Renaming fields in place.** That's a breaking change; add new, deprecate old.
- **"GraphQL is faster."** It saves round trips and bytes for the client; the server can easily become slower (N+1) without batching.
- **Reusing protobuf field numbers.** Old messages will be decoded as the wrong field.

## Before moving on

- [ ] I can design REST endpoints for a small app with correct methods and status codes
- [ ] I can explain offset vs cursor pagination and why cursors scale
- [ ] I know which API changes are breaking and how to version
- [ ] I can explain what GraphQL solves and the N+1 problem
- [ ] I can explain why gRPC/protobuf is compact and when to use it

## Go deeper (optional)

- [MDN: HTTP request methods](https://developer.mozilla.org/en-US/docs/Web/HTTP/Methods)
- [GraphQL: Introduction](https://graphql.org/learn/)
- [gRPC: Introduction](https://grpc.io/docs/what-is-grpc/introduction/)
- [Protocol Buffers: Encoding](https://protobuf.dev/programming-guides/encoding/)
- [Stripe API reference](https://docs.stripe.com/api) — a widely admired REST API (pagination, idempotency, versioning)
