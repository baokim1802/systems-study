# Design a Ride-Sharing Service

> Uber, Grab and Lyft must answer one question thousands of times a second: "which available driver is closest to this rider, right now?" Drivers move constantly, so this is a lesson in fast-changing location data, geographic indexing, and keeping a trip's state correct when phones drop off the network.

## The big idea

Picture a city map on a wall, divided into a grid of squares. Every few seconds, each taxi driver radios in, and a dispatcher moves that driver's pin into the right square. When a customer calls from square C4, the dispatcher doesn't scan the whole city; she looks at C4 and its eight neighbors, picks the closest free taxi, and radios "go to Main St." If that driver doesn't answer in 10 seconds, she tries the next one.

That's exactly the system:

- the **grid** is a geospatial index (geohash, quadtree, or Uber's hexagonal H3),
- the **radio check-ins** are location updates from the driver app every few seconds,
- the **dispatcher** is the matching service,
- the trip's progress (requested, accepted, picked up, finished) is a **state machine**.

## Step 1: Clarify requirements

**Functional**

- Drivers go online/offline and send their location.
- Riders see nearby cars on the map and request a ride.
- The system matches the request to a nearby available driver, who can accept or decline.
- Both apps track the trip live; the trip ends with a fare (payment itself is Day 65).

**Non-functional**

- Matching in a few seconds; location on the rider's map at most a few seconds old.
- **Never assign one driver to two riders.**
- Trip state must survive server crashes and phones losing signal.
- High availability per city; an outage in one region shouldn't affect others.

## Step 2: Back-of-the-envelope estimates

```text
Drivers online at peak       1M
Location update interval     every 4 s
Location writes              1M / 4 = 250,000 updates/s
Update size                  ~100 B (driver id, lat, lng, heading, speed, timestamp, status)
Ingest bandwidth             250k × 100 B = 25 MB/s

Current-location memory      1M × ~100 B = 100 MB (fits in RAM easily)
History if kept, per day     250k/s × 86,400 × 100 B ≈ 2.2 TB/day (upper bound at peak rate)

Trips per day                20M → 20e6 / 86,400 ≈ 230 requests/s, peak maybe ~1,000/s
```

Two big takeaways: the **write rate** (250k/s) is the challenge, not data size; and the *current* location set is tiny, so it belongs **in memory**, not in a disk-based database row per driver that's rewritten every 4 seconds. Location history goes to a cheap append-only store (or a stream, Day 34) for analytics and fare disputes.

## Step 3: API

```text
Driver app (WebSocket or frequent HTTP, Day 18)
  PUT  /v1/drivers/me/location   { lat, lng, heading, speed, ts }
  POST /v1/drivers/me/status     { status: "available" | "offline" }
  POST /v1/offers/{offerId}/accept | /decline

Rider app
  GET  /v1/drivers/nearby?lat=..&lng=..          cars for the map (approximate)
  POST /v1/trips   { pickup, dropoff, Idempotency-Key }   → { tripId, status: "MATCHING" }
  GET  /v1/trips/{id}                            or a push channel for live updates
  POST /v1/trips/{id}/cancel
```

## Step 4: Data model

```text
In memory (sharded by region), refreshed every few seconds:
  driver_locations   driver_id → { lat, lng, cell, status, updated_at }
  cell_index         geohash cell → set of driver_ids

Durable (SQL, Day 20), small and transactional:
  drivers  (driver_id, name, vehicle, rating, status, current_trip_id)
  trips    (trip_id, rider_id, driver_id, status, pickup, dropoff, fare, version, timestamps)

Append-only:
  location_history (driver_id, ts, lat, lng)     → stream / time-series store
```

## Step 5: High-level design

```text
 driver app ──location every 4s──▶ ┌──────────────┐     ┌─────────────────────────┐
                                   │ Location svc │────▶│ Geo index (in-memory,   │
                                   └──────┬───────┘     │ sharded by region/cell) │
                                          │ stream       └───────────▲─────────────┘
                                          ▼                          │ nearby query
                                  history store (Kafka →             │
                                  time-series / object storage)      │
 rider app ──request ride──▶ ┌───────────┐   ┌──────────────────────┴──┐
                             │ Trip svc  │──▶│ Matching svc             │
                             │ state     │   │ candidates → rank by ETA │
                             │ machine   │◀──│ → offer → atomic assign  │
                             └─────┬─────┘   └───────────┬──────────────┘
                                   ▼                     │ offer
                              Trips DB (SQL)             ▼
                                              notification / WebSocket to driver
```

## Step 6: Deep dives

### Geohash: turning 2-D into a string

A **geohash** repeatedly cuts the world in half: is the longitude in the east or west half? (1 bit) Is the latitude in the north or south half? (1 bit) Alternate, and every 5 bits become one base-32 character. Nearby points usually share a long prefix, so "drivers near me" becomes "drivers whose geohash starts with `dr5ru`", a fast lookup in a hash map or sorted index.

```js
const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

function geohash(lat, lng, length) {
  const latR = [-90, 90], lngR = [-180, 180];
  let evenBit = true, bits = 0, value = 0, out = "";
  while (out.length < length) {
    const range = evenBit ? lngR : latR;          // longitude first, then alternate
    const v = evenBit ? lng : lat;
    const mid = (range[0] + range[1]) / 2;
    if (v >= mid) { value = value * 2 + 1; range[0] = mid; }
    else          { value = value * 2;     range[1] = mid; }
    evenBit = !evenBit;
    if (++bits === 5) { out += BASE32[value]; bits = 0; value = 0; }
  }
  return out;
}

console.log(geohash(40.7580, -73.9855, 7)); // "dr5ru7v"  (Times Square)
console.log(geohash(40.7484, -73.9857, 5)); // "dr5ru"    (Empire State Building: same 5-char cell)
```

How big is a cell?

| Length | Cell size (approx., at the equator) |
|---|---|
| 4 | 39 km × 19.5 km |
| 5 | 4.9 km × 4.9 km |
| 6 | 1.2 km × 0.61 km |
| 7 | 153 m × 153 m |

For finding drivers, length 6 is a good start: look in the rider's cell **plus its 8 neighbors**. Why neighbors? Because a rider near the edge of a cell can be 10 meters from a driver who's in the next cell with a completely different hash. If too few drivers are found, widen to length 5.

### Quadtrees and H3

A grid with fixed cells wastes effort: Manhattan has thousands of drivers per cell, a rural road has none. A **quadtree** splits a square into four only when it holds more than N drivers, so dense areas get tiny cells and empty areas stay big. The catch: with drivers moving every 4 s, the tree must be updated constantly. Uber built **H3**, a grid of hexagons; hexagons have the nice property that all 6 neighbors are the same distance away. In an interview, geohash + neighbors is a perfectly good answer; mention quadtrees for uneven density.

### Matching

1. Find candidate drivers in the rider's cell and neighbors with `status = available`.
2. Rank by **ETA on the road network**, not straight-line distance (a driver across a river may be 300 m away but 15 minutes out). Straight-line distance via the haversine formula is a cheap pre-filter.
3. Send an **offer** to the best driver with a timeout (~10–15 s). Declined or timed out → next candidate.
4. On accept, **atomically** assign.

The atomic step is what prevents double booking (remember races from Day 7 and lost updates from Day 22). Use a conditional update so only one assignment can win:

```text
UPDATE drivers SET status = 'on_trip', current_trip_id = 'T9'
WHERE driver_id = 'D7' AND status = 'available';
-- 1 row updated → you got the driver. 0 rows → someone else did; try the next candidate.
```

Also, while a driver holds an offer, mark them `offered` so two matching workers don't offer the same driver simultaneously. Routing all requests for a region to one matching worker (partition by region, Day 32) removes most races entirely.

### The trip state machine

```text
REQUESTED ─▶ MATCHING ─▶ DRIVER_ASSIGNED ─▶ DRIVER_ARRIVED ─▶ IN_PROGRESS ─▶ COMPLETED ─▶ PAID
                 │              │                  │
                 ▼              ▼                  ▼
            NO_DRIVERS      CANCELLED          CANCELLED (fee)
```

Only listed transitions are legal, and each is a conditional write (`... WHERE status = 'DRIVER_ARRIVED' AND version = 7`). This makes retries safe: if the driver's "start trip" request is sent twice, the second finds status already `IN_PROGRESS` and does nothing (idempotent, Day 43). Every transition is also published as an event (to pricing, notifications, analytics).

### When the phone goes dark

A driver enters a tunnel mid-trip. The trip **stays `IN_PROGRESS`** on the server; nothing is decided from a missing heartbeat alone. The driver app buffers location points and uploads them when it reconnects, so the route (and fare) is complete. If a driver is silent for minutes *before* pickup, the system can notify the rider and re-match.

### Scaling the location writes

250k updates/s are spread over **region shards**: each city (or group of cells) lives on its own set of in-memory servers, so New York traffic never touches Jakarta's servers. Redis offers this out of the box (`GEOADD` stores points in a sorted set keyed by a geohash-like score, `GEOSEARCH` finds points within a radius). Updates are last-write-wins and short-lived, so losing a few on a crash is fine: the next update arrives in 4 s.

## Step 7: Bottlenecks and trade-offs

| Decision | Trade-off |
|---|---|
| Update every 4 s vs 1 s | 4× fewer writes vs a less accurate map |
| In-memory geo index | very fast vs rebuilt from fresh updates after a crash (acceptable) |
| Geohash grid vs quadtree | simple and easy to shard vs adapts to density |
| Nearest by distance vs by ETA | cheap vs accurate; use distance as a pre-filter |
| Region sharding | isolation and locality vs hot spots (New Year's Eve in one city) |

## In an interview

Interviewers look for: the write-rate math, keeping current locations in memory, a geospatial index with the neighbor-cell edge case, an atomic assignment to prevent double booking, and a clear trip state machine. Model summary:

> "Drivers send locations every 4 s: 250k writes/s for 1M drivers, but only ~100 MB of current state, so we keep it in an in-memory geo index sharded by region and stream the history to cheap storage. A request searches the rider's geohash cell and its eight neighbors, ranks available drivers by road ETA, and offers sequentially with a timeout. Acceptance is a conditional update on the driver's status so one driver can't be assigned twice, and trips follow an explicit state machine with idempotent, versioned transitions."

## Common mistakes

- **Writing every location update to a relational table with a lat/lng index.** 250k random updates/s will crush it.
- **Searching only the rider's own cell.** Edge cases miss the closest driver.
- **Ranking by straight-line distance only.** Rivers and one-way streets exist.
- **Check-then-assign without atomicity**, which lets two riders get one driver.
- **Ending a trip when the heartbeat stops.** Network loss is not the same as the trip ending.

## Before moving on

- [ ] I can estimate location-update throughput and memory for drivers
- [ ] I can explain how a geohash is built and why we search neighbor cells
- [ ] I can compare geohash grids, quadtrees and hexagons in two sentences each
- [ ] I can write the conditional update that prevents double booking
- [ ] I can draw the trip state machine and explain why transitions are idempotent

## Go deeper (optional)

- [Geohash on Wikipedia](https://en.wikipedia.org/wiki/Geohash)
- [Quadtree on Wikipedia](https://en.wikipedia.org/wiki/Quadtree)
- [Haversine formula on Wikipedia](https://en.wikipedia.org/wiki/Haversine_formula)
- [Redis GEOSEARCH documentation](https://redis.io/docs/latest/commands/geosearch/)
- [H3 documentation](https://h3geo.org/)
