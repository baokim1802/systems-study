# Object Storage and Files

> Photos, videos, backups, logs, ML datasets: most of the bytes in the world live in object storage like Amazon S3. Knowing how it works, and how to move big files through it without melting your servers, is a core system design skill.

## The big idea

Think of a **coat check**. You hand over your coat, you get a ticket with a number, and later the ticket gets your coat back. You can't ask the coat check to "change the left sleeve"; you can only hand in a whole coat, get a whole coat back, or have it thrown away. In exchange the coat check can be enormous, cheap and very careful with your things.

**Object storage** works the same way:

- An **object** is a blob of bytes (a JPEG, a 4 GB video, a CSV) plus a little **metadata** (content type, size, custom tags).
- Each object lives in a **bucket** (a named container) under a **key** (its name), like `photos/user42/2026/beach.jpg`.
- The operations are basically `PUT` (store whole object), `GET` (read it, optionally a byte range), `DELETE`, and `LIST` (keys with a prefix). You can't edit the middle of an object; you replace it.

Despite the slashes, there are **no real folders**. `photos/user42/` is just a prefix of the key; the "folders" in the S3 console are a display trick.

## Three kinds of storage

| | Block storage | File storage | Object storage |
|---|---|---|---|
| Looks like | a raw disk | a shared folder tree | a giant key → blob map over HTTP |
| Examples | AWS EBS, a laptop SSD | NFS, AWS EFS | Amazon S3, Google Cloud Storage, Azure Blob |
| Edit in place? | yes (any block) | yes (seek and write) | no, replace whole object |
| Attached to | one machine at a time | many machines | anyone with permission, over the internet |
| Scale | terabytes | large | practically unlimited (S3 holds hundreds of trillions of objects) |
| Typical use | databases, OS disks | shared app files | media, backups, data lakes, static sites |

Remember Day 8: a filesystem gives you inodes, directories and `fsync`. Object storage throws most of that away in exchange for scale, durability and a simple HTTP API.

## How it actually works: metadata vs data

Inside, an object store is really **two systems**:

```text
          PUT photos/beach.jpg (3 MB)
                    │
              ┌─────▼─────┐
              │ front end │  auth, routing
              └─────┬─────┘
          ┌─────────┴──────────┐
          ▼                    ▼
 ┌─────────────────┐   ┌──────────────────────┐
 │ metadata service│   │   data (blob) nodes  │
 │ key → {size,    │   │ the actual bytes,    │
 │  type, etag,    │   │ split into chunks,   │
 │  chunk locations│   │ spread over many     │
 │  }              │   │ disks and racks      │
 └─────────────────┘   └──────────────────────┘
   small, many reads      huge, mostly sequential IO
   (a sharded database)   (cheap disks)
```

- The **metadata service** is like a database (Days 20 and 32): a sharded, replicated index from `bucket + key` to "which chunks, on which machines". It's small per object but must be fast and consistent.
- The **data nodes** store the bytes, in chunks, on large cheap disks. They don't need to know what a "key" is.

Separating them lets each scale independently: billions of tiny metadata rows on fast storage, exabytes of bytes on cheap storage. When you design "Dropbox" or "YouTube" in an interview, you'll make the same split yourself: metadata in a database, file bytes in object storage.

Since December 2020, S3 provides **strong read-after-write consistency**: once a PUT succeeds, any later GET or LIST sees it. (Before that, overwrites were only eventually consistent, an example of Day 40's topic.)

## Durability: what "eleven nines" means

S3 Standard is designed for **99.999999999% durability** (eleven 9s) per object per year, and 99.99% availability. These are different things:

- **Durability**: the chance your data still exists. Losing data is unforgivable.
- **Availability**: the chance you can reach it right now. A brief outage is annoying, not fatal.

```text
annual loss probability per object = 1 − 0.99999999999 = 10^-11

store 10,000,000 objects:
expected losses per year = 10^7 × 10^-11 = 10^-4
→ about one lost object every 10,000 years
```

That's AWS's own illustration. The real risk to your data is not disks dying; it's **you** deleting it (bugs, bad scripts). That's why versioning and object lock exist.

## Replication vs erasure coding

How do you survive disks dying? The simple way is **replication**: keep 3 full copies on 3 different machines. Survives 2 failures, costs **3×** the space.

**Erasure coding** is smarter. The idea, in miniature, with XOR (`^` in JavaScript, which flips bits; `a ^ b ^ b === a`):

```js
const d1 = 0b1011, d2 = 0b0110;  // two data chunks
const p  = d1 ^ d2;              // parity chunk = 0b1101

// the disk with d1 dies. Rebuild it from the others:
const rebuilt = p ^ d2;
console.log(rebuilt === d1);     // true
```

Two data chunks + one parity chunk = 1.5× space, survives any 1 loss. Real systems use **Reed–Solomon codes**, which generalize this: split an object into `k` data chunks, compute `m` parity chunks, and **any `k` of the `k + m` chunks** can rebuild the whole thing.

| Scheme | Storage overhead | Failures survived |
|---|---|---|
| 3× replication | 3.0× | 2 |
| RS(6, 3): 6 data + 3 parity | 9/6 = 1.5× | 3 |
| RS(10, 4): 10 data + 4 parity | 14/10 = 1.4× | 4 |

More safety for half the disk space. The cost: rebuilding a lost chunk means reading `k` other chunks across the network, and small objects get split awkwardly. So systems often replicate small or hot data and erasure-code large, cold data. Chunks are placed across different racks and even different **availability zones** (separate data centers, Day 51) so a fire or power failure can't take out too many at once.

## Multipart upload

Uploading a 10 GB video as one HTTP request is fragile: a Wi-Fi blip at 9.8 GB means starting over. **Multipart upload** splits it:

1. `CreateMultipartUpload` → get an `uploadId`.
2. Upload parts (in S3: 5 MB to 5 GB each, up to 10,000 parts) **in parallel**, each with its part number. Retry only the parts that fail.
3. `CompleteMultipartUpload` with the list of parts → the store stitches them into one object.

S3 allows up to 5 GB in a single PUT and up to **5 TB** per object with multipart. AWS recommends multipart for anything over about 100 MB.

```text
10 GB file, 100 MB parts → 100 parts
8 parallel uploads over a 400 Mbit/s link: link is the bottleneck either way,
but one failed part costs 100 MB of re-upload, not 10 GB
```

## Presigned URLs: keep bytes away from your servers

Naive design: the phone uploads the video to your API server, which then uploads it to S3. Every byte crosses your servers twice, ties up connections, and you pay for bandwidth and CPU.

Better: your server hands the client a **presigned URL**, a normal S3 URL with a cryptographic signature (Day 15) and expiry baked into its query string. Anyone holding it may do exactly that one operation (PUT this key, or GET that key) until it expires (at most 7 days for S3's signature version 4).

```text
1. client  → API:  "I want to upload beach.jpg (3 MB)"
2. API checks auth/quota, picks key photos/u42/abc123.jpg,
   returns a presigned PUT URL valid for 15 minutes
3. client  → S3:   PUT bytes directly using that URL
4. S3 → event (or client → API): "upload complete" → save metadata row,
   enqueue thumbnail job (Day 34)
```

Your API handles a few small JSON requests; S3 handles the gigabytes. Downloads work the same way, and for public or popular files you put a CDN (Day 30) in front.

## Other features worth knowing

- **Range GETs**: `Range: bytes=0-1048575` fetches just the first MB. Video players and parallel downloaders rely on this.
- **Storage classes**: hot (Standard), infrequent access, and archive tiers (Glacier) trade cheaper storage for slower or pricier reads. **Lifecycle rules** move old objects automatically.
- **Versioning**: overwrites and deletes keep old versions, guarding against mistakes.
- **Event notifications**: "object created" can trigger a queue message or a function.

## The math

```text
Photo app: 2 million uploads/day, average 3 MB, keep originals + 3 thumbnails (~0.3 MB total)
per day   = 2,000,000 × 3.3 MB = 6.6 TB/day
per year  = 6.6 TB × 365 ≈ 2.4 PB/year

raw disk with 3× replication   = 7.2 PB
raw disk with RS(10,4), 1.4×   = 3.4 PB   → saves ~3.8 PB of disks per year

Price check: at roughly $0.023 per GB-month (S3 Standard list price, first tier),
2.4 PB ≈ 2,400,000 GB × $0.023 ≈ $55,000 per month for one year's data
```

## In an interview

Any design involving files (Dropbox, Instagram, YouTube, WhatsApp media) should include:

- "Metadata in a database, bytes in object storage."
- Presigned URLs for direct upload/download, multipart for large files.
- A CDN in front for reads.
- An async pipeline triggered on upload (thumbnails, transcoding, virus scan).

Good paragraph: "Clients upload directly to S3 using a presigned multipart URL from our API, so our servers never touch the bytes. When the upload completes, an event goes to a queue; workers generate thumbnails and update the photo's metadata row in Postgres from `pending` to `ready`. Reads go through a CDN backed by the bucket. S3's eleven nines comes from erasure coding across availability zones, and we enable versioning to protect against our own bugs."

## Common mistakes

- **Storing images as BLOBs in the main database**: bloats backups and replication. Store a key/URL instead.
- **Proxying uploads through app servers**: wastes bandwidth; use presigned URLs.
- **Confusing durability with availability**.
- **Thinking prefixes are folders**: renaming a "folder" means copying every object.
- **Long-lived presigned URLs**: a leaked link is a leaked file. Keep expiry short.

## Before moving on

- [ ] I can explain object vs block vs file storage
- [ ] I can draw the metadata/data split inside an object store
- [ ] I can explain erasure coding with XOR and compare overhead to 3× replication
- [ ] I can describe the presigned URL upload flow step by step
- [ ] I can estimate yearly storage for a photo or video app

## Go deeper (optional)

- [Amazon S3 User Guide: What is Amazon S3?](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html)
- [Amazon S3: Uploading and copying objects using multipart upload](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html)
- [Wikipedia: Erasure code](https://en.wikipedia.org/wiki/Erasure_code)
- [Wikipedia: Object storage](https://en.wikipedia.org/wiki/Object_storage)
