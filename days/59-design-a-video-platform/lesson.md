# Design a Video Platform

> Video is the heaviest thing most systems ever move: it dominates internet traffic. Designing a YouTube-style platform teaches you pipelines, object storage, CDNs and bandwidth math, and the numbers are so large they force every decision.

## The big idea

Imagine a bakery that receives raw dough from thousands of home cooks every minute. Before anything can be sold, each lump is baked into **five sizes of loaf** (small for people with tiny bags, large for people with big ones). The baked loaves are shipped to **corner shops in every neighborhood**, so customers never travel to the central bakery. And a customer on a bike with a small basket gets small loaves; when they switch to a car, they start getting big ones.

- The dough is the **original upload**.
- Baking into sizes is **transcoding** into several resolutions and bitrates.
- The corner shops are the **CDN** (Day 30).
- Switching loaf size mid-trip is **adaptive bitrate streaming (ABR)**.

## Step 1: Clarify requirements

**Functional**

- Creators upload videos (up to, say, 10 GB), including from flaky phone networks.
- Viewers watch on phones, laptops and TVs, with smooth playback on any connection.
- Show title, thumbnail, view count. (Search, comments, recommendations: out of scope.)

**Non-functional**

- Playback starts fast (under ~2 s) and rarely stalls (**rebuffering** is the metric viewers hate most).
- Uploads must never be lost once accepted.
- Processing can take minutes; it's fine for a new video to be "processing" for a while.
- Massive read-to-write ratio: a video is uploaded once and watched thousands of times.
- Cost matters enormously: storage and bandwidth are the biggest bills.

## Step 2: Back-of-the-envelope estimates

A widely cited YouTube figure is **500 hours of video uploaded every minute**. Let's use it.

```text
Upload volume  = 500 h/min × 1,440 min/day = 720,000 hours of video per day
```

Bitrate (bits per second of video) decides size. A typical **bitrate ladder**:

| Rendition | Resolution | Bitrate |
|---|---|---|
| 240p | 426×240 | 0.3 Mbps |
| 360p | 640×360 | 0.7 Mbps |
| 480p | 854×480 | 1.5 Mbps |
| 720p | 1280×720 | 2.5 Mbps |
| 1080p | 1920×1080 | 5.0 Mbps |
| **Total** | | **10 Mbps** |

```text
One hour, all renditions = 10 Mbps × 3,600 s = 36,000 Mb = 4,500 MB = 4.5 GB
Transcoded per day       = 720,000 h × 4.5 GB  ≈ 3.2 PB/day
Originals (~8 Mbps)      = 720,000 h × 3.6 GB  ≈ 2.6 PB/day
Total                    ≈ 5.8 PB/day          ≈ 2 EB/year (before redundancy)
```

Remember Day 2: divide bits by 8 to get bytes. Missing that factor is the classic mistake.

Now the watching side. Assume **1 billion hours watched per day** (YouTube announced passing this in 2017):

```text
Average concurrent viewers = 1e9 h / 24 h          ≈ 42 million
Average egress             = 42M × 3 Mbps (avg)    ≈ 125 Tbps
Peak (×2)                                          ≈ 250 Tbps
Origin load at 95% CDN hit rate = 5% × 125 Tbps    ≈ 6 Tbps
```

No single data center can serve 125 Tbps. The CDN isn't an optimization here; it is the design.

## Step 3: API

```text
POST /v1/videos                      → { videoId, uploadUrl(s) }   create + get presigned URLs
PUT  <presigned part URL>            upload parts directly to object storage (Day 36)
POST /v1/videos/{id}/complete        → { status: "processing" }
GET  /v1/videos/{id}                 → { title, status, thumbnailUrl, manifestUrl, views }
GET  <cdn>/v/{id}/master.m3u8        the streaming manifest (served by the CDN)
POST /v1/videos/{id}/views           view event (batched by the player)
```

Video bytes never pass through your API servers. Clients upload straight to object storage with **presigned URLs** and stream straight from the CDN.

## Step 4: Data model

```text
videos      (video_id PK, owner_id, title, description, status: uploading|processing|ready|failed,
             duration_s, original_key, manifest_key, created_at)
renditions  (video_id, rendition, codec, bitrate, storage_prefix)
view_counts (video_id, count)                ← updated in batches, not per view
```

Metadata is small and relational: a sharded SQL database (Days 20, 32) is fine. The bytes live in object storage under keys like `videos/{id}/720p/seg_00042.ts`.

## Step 5: High-level design

```text
 UPLOAD PATH
 creator ──presigned multipart PUT──▶ ┌──────────────────┐
    │                                 │ Object storage   │ originals
    └──POST /complete──▶ API ──event──▶ queue (Day 34)   └──────────────────┘
                                          │
                                          ▼
                          ┌─────────────────────────────────┐
                          │ Transcoding orchestrator (DAG)  │
                          │ split → encode × N → package    │
                          └───────┬───────────────┬─────────┘
                                  ▼               ▼
                       worker fleet (1000s)   thumbnails, checks
                                  │
                                  ▼
                       Object storage: segments + manifests
                                  │ status=ready
 WATCH PATH                       ▼
 viewer ──▶ CDN edge (cache hit ~95%) ──miss──▶ origin shield ──▶ object storage
   │
   └──▶ API (metadata, view events) ──▶ SQL + counters
```

## Step 6: Deep dives

### Resumable uploads

A 4 GB file over a phone connection will be interrupted. **Multipart upload** splits it into parts (say 8 MB each, so 500 parts); each part is uploaded and acknowledged independently and retried alone if it fails. The client asks "which parts do you already have?" and resumes. Only `complete` stitches them together.

### Transcoding as a pipeline

A **codec** compresses video (H.264 plays everywhere; VP9 and AV1 make files roughly 30–50% smaller at similar quality but cost much more CPU to encode). Transcoding one long video serially is slow, so the orchestrator:

1. **Splits** the original into chunks of a few seconds at keyframe boundaries (a keyframe is a full picture that later frames are described relative to).
2. **Encodes** every chunk × every rendition in parallel: a 60-minute video in 10 s chunks is 360 chunks × 5 renditions = 1,800 independent tasks.
3. **Packages** the results into streaming **segments** (typically 2–6 s each) plus **manifests**, and generates thumbnails.

This is a **DAG** (directed acyclic graph: tasks with dependencies) on top of a queue. If a worker dies mid-task, its message isn't acked, so it becomes visible again and another worker redoes that chunk. Tasks must be **idempotent**: writing the same output key twice is harmless (Day 43).

### Adaptive bitrate streaming (HLS / DASH)

The player first downloads a **master manifest** listing renditions:

```text
#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=700000,RESOLUTION=640x360
360p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720
720p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080
1080p/index.m3u8
```

Each rendition's playlist lists its segments. Because all renditions are cut at the same points, the player can switch quality **at any segment boundary**. A simplified decision rule:

```js
// Pick the best rendition we can sustain, leaving a safety margin.
function pickRendition(renditions, measuredKbps, bufferSeconds) {
  const safety = bufferSeconds < 10 ? 0.5 : 0.8;   // low buffer → play it safe
  const budget = measuredKbps * safety;
  const sorted = [...renditions].sort((a, b) => b.kbps - a.kbps);
  return sorted.find((r) => r.kbps <= budget) ?? sorted[sorted.length - 1];
}

const ladder = [{ name: "360p", kbps: 700 }, { name: "720p", kbps: 2500 }, { name: "1080p", kbps: 5000 }];
console.log(pickRendition(ladder, 4000, 25).name); // 720p  (budget 3200)
console.log(pickRendition(ladder, 4000, 4).name);  // 360p  (budget 2000, buffer is low)
```

Real players (and Netflix's research) use smarter rules mixing throughput and buffer level, but this is the idea.

### CDN and the long tail

Video popularity is extremely skewed: a small fraction of videos gets most views. Popular segments stay hot in edge caches; the **long tail** (millions of rarely watched videos) mostly misses. Tricks:

- An **origin shield**: a middle cache layer so edge misses don't all hit storage.
- Putting cache boxes **inside ISPs** (Netflix's Open Connect does this), cutting transit cost.
- Pre-warming edges for a big premiere.

### View counts

1 billion hours watched means billions of views a day; `UPDATE videos SET views = views + 1` per view would melt one hot row. Instead, players send events to a stream (Day 34), stream processors aggregate per video per minute, and write one increment per batch. A count that lags a few seconds is fine.

### Saving money on cold videos

If most uploads are barely watched, don't pay full price for them: encode only a few renditions at first and add 1080p/AV1 when a video gets popular; move old segments to colder, cheaper storage classes; and use erasure coding (about 1.5× overhead) instead of 3 full copies (Day 36).

## Step 7: Bottlenecks and trade-offs

| Decision | Trade-off |
|---|---|
| Many renditions | smoother playback vs storage and encode cost |
| Short segments (2 s) | faster switching and startup vs more requests and manifest overhead |
| AV1/VP9 | ~30–50% less bandwidth vs much higher encode CPU and device support |
| Encode on demand for cold videos | lower cost vs a slower first view |

## In an interview

Interviewers look for: presigned/multipart uploads that bypass app servers, an async transcoding pipeline with parallel chunks, ABR with a manifest, the CDN as the core of delivery, and bandwidth math with bits vs bytes right. Model summary:

> "Uploads go directly to object storage via presigned multipart URLs. Completion publishes an event; an orchestrator splits the video into chunks and fans out encode tasks for a 5-rung bitrate ladder to a worker fleet, then packages HLS segments and manifests. Players fetch the manifest from a CDN and switch renditions per segment based on throughput and buffer. At ~125 Tbps average egress, a 95%+ CDN hit rate is essential; view counts are aggregated from an event stream."

## Common mistakes

- **Uploading through your API servers.** They'd need to proxy petabytes a day; use presigned URLs.
- **Mixing bits and bytes.** 10 Mbps for an hour is 4.5 GB, not 36 GB.
- **One giant file per resolution.** Without segments the player can't switch quality mid-video.
- **Synchronous transcoding.** The upload request can't wait 20 minutes; return "processing".
- **Counting views with a row update per view.** Aggregate first.

## Before moving on

- [ ] I can sketch the upload → transcode → package → CDN pipeline
- [ ] I can explain adaptive bitrate streaming and why segments are aligned across renditions
- [ ] I can compute storage per day from upload hours and a bitrate ladder
- [ ] I can compute egress bandwidth and the origin load for a given CDN hit rate
- [ ] I can name two ways to cut cost for rarely watched videos

## Go deeper (optional)

- [HTTP Live Streaming on Wikipedia](https://en.wikipedia.org/wiki/HTTP_Live_Streaming)
- [Adaptive bitrate streaming on Wikipedia](https://en.wikipedia.org/wiki/Adaptive_bitrate_streaming)
- [Content delivery network on Wikipedia](https://en.wikipedia.org/wiki/Content_delivery_network)
