# Storage, Disks and Filesystems

> RAM forgets everything when the power goes out; disks don't. Every database, log and uploaded file ends up on a disk, and the way disks really work (blocks, caches, `fsync`, sequential vs random access) shapes how databases, queues and logs are designed.

## The big idea

Think of a huge warehouse of identical numbered shelves, each holding exactly one box of 4 KB. The warehouse itself only understands "give me box 81,223" or "put this in box 5,002". It has no idea what a "file" or a "folder" is.

A **filesystem** is the warehouse's catalog: "the file `photo.jpg` is 10 KB and lives in boxes 81,223, 81,224 and 90,001; it belongs to Kim; it was modified yesterday." Without the catalog, the boxes are just anonymous bytes.

And because walking to the warehouse is slow, there is a **front desk** (RAM) that keeps copies of recently used boxes and collects outgoing boxes to drop off in batches. That front desk is the **page cache**, and it is why "I saved the file" and "the file is safely on disk" are two different things.

## Two kinds of disk

### Hard disk drives (HDD): spinning platters

An HDD stores bits magnetically on metal platters spinning at 5,400–15,000 RPM (7,200 is typical). A read/write head on an arm moves across the platter, like a record player.

To read a random block it must:

1. **Seek**: move the arm to the right track (about 4–9 ms).
2. **Rotate**: wait for the block to spin under the head. At 7,200 RPM, one rotation is `60 / 7,200 s = 8.3 ms`, so on average half that: about 4.2 ms.
3. **Transfer**: read the data (fast once it's under the head).

So a random read costs about **10 ms**, which means only about **100–200 random reads per second** (IOPS, I/O operations per second). But once the head is in place, data streams off at 150–250 MB/s. **Sequential is great, random is terrible.**

### Solid-state drives (SSD): flash memory

An SSD has no moving parts. It stores bits as charge in **NAND flash** cells. A random 4 KB read takes roughly 20–100 µs, and a modern **NVMe** SSD (one that plugs straight into the fast PCIe bus) can do hundreds of thousands to over a million random reads per second and 3–7 GB/s sequentially.

Flash has a quirk: you can write a fresh **page** (typically 4–16 KB), but you cannot overwrite it in place. You must first erase a whole **erase block** (hundreds of pages, several MB). So the SSD's internal controller, the **flash translation layer** (FTL), writes new versions to fresh pages and garbage-collects old ones in the background. Consequences:

- **Write amplification**: one logical write can cause several physical writes inside the drive.
- **Wear**: each cell survives a limited number of erase cycles, so the FTL spreads writes around (**wear leveling**).
- **TRIM**: the OS tells the drive which blocks are no longer used, so garbage collection is cheaper.

| | HDD | NVMe SSD |
|---|---|---|
| Random 4 KB read | ~10 ms | ~20–100 µs |
| Random IOPS | ~100–200 | ~500,000+ |
| Sequential throughput | 150–250 MB/s | 3–7 GB/s |
| Cost per TB | lowest | a few times more |
| Good for | cold storage, backups, big sequential files | databases, anything random |

Even on SSDs, sequential access is still faster and gentler (less write amplification), so the "prefer sequential" lesson survives.

## Blocks

Disks expose storage as fixed-size **blocks** (or sectors), and filesystems allocate space in blocks too, usually **4 KB**. That matches the memory page size (Day 06), which is not a coincidence: the OS moves data between disk and RAM a page at a time.

Consequence: a file takes at least one whole block. A 1-byte file uses 4 KB of disk; a million tiny 100-byte files use about 4 GB, not 100 MB.

```text
$ echo "hi" > tiny.txt
$ ls -l tiny.txt     → 3 bytes    (logical size)
$ du -h tiny.txt     → 4.0K       (space actually used)
```

## Files, directories and inodes

On Unix filesystems (ext4, XFS, APFS works similarly), each file is described by an **inode** (index node): a small record holding the file's **metadata**:

- size, owner, permissions (`rwxr-xr-x`, Day 02)
- timestamps (created/modified/accessed)
- link count
- pointers to the data blocks (or to ranges of blocks, called extents)

What is **not** in the inode? The file's **name**. A **directory** is just a special file containing a table of `name → inode number`.

```text
directory /home/kim            inode 5531                    data blocks
┌──────────────┬───────┐       ┌──────────────────────┐      ┌────────┐
│ notes.txt    │ 5531 ─┼─────> │ size: 9,000 bytes    │ ───> │ blk 811│
│ photo.jpg    │ 7720  │       │ owner: kim, 644      │ ───> │ blk 812│
│ projects/    │ 2018  │       │ modified: 2026-09-30 │ ───> │ blk 990│
└──────────────┴───────┘       │ links: 1             │      └────────┘
                               └──────────────────────┘
```

This design explains some surprising behavior:

- **Renaming or moving** a file within one filesystem is instant, whatever its size: only a directory entry changes. And `rename` is **atomic**: readers see either the old or the new file, never half of each.
- **Hard links**: two names pointing to the same inode. The data is deleted only when the link count hits 0 *and* no process has it open.
- **Deleting a log file that a process still has open frees no space**. The disk stays full until the process closes it or restarts. (A classic on-call puzzle: `df` says full, `du` can't find the files.)
- **Running out of inodes**: a filesystem has a fixed number of inodes on many setups. Millions of tiny cache files can exhaust inodes while the disk still has free gigabytes.

`stat notes.txt` and `ls -i` show you inode details.

## The page cache: RAM in front of the disk

Linux uses otherwise-free RAM to cache file data, the **page cache**:

- **Reads**: the first read goes to disk; later reads of the same pages come from RAM at memory speed. That is why the second run of a command is faster, and why "free" memory on a server is rarely free (and that's good).
- **Writes**: `write()` copies your data into the page cache, marks those pages **dirty**, and returns immediately. The kernel flushes dirty pages to disk later (on Linux, typically within about 30 seconds, or sooner under memory pressure).

So when `write()` returns, your data is **in RAM, not on disk**. If the machine loses power in the next few seconds, it is gone.

## fsync and durability

**Durability** means: once I told the user "saved", it survives a crash or power loss. To get it, a program calls **`fsync(fd)`**: "don't return until this file's data (and metadata) has reached stable storage."

```js
const fs = require("fs");

function durableWriteFileSync(path, data) {
  const tmp = path + ".tmp";
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);              // 1. data really on disk
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, path);        // 2. atomic swap: old or new, never half
  const dir = fs.openSync(require("path").dirname(path), "r");
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }  // 3. make the rename durable
}
```

This "write temp, fsync, rename, fsync directory" recipe is how careful programs (editors, databases, package managers) avoid leaving a half-written config file after a crash.

`fsync` is slow by memory standards: from tens of microseconds on an SSD with power-loss protection to several milliseconds on an HDD (it must wait for the platter). That's why databases:

- write changes first to a sequential **write-ahead log** (WAL) and fsync only that (Day 22);
- use **group commit**: one fsync covers many transactions that arrived in the same few milliseconds.

Some systems let you choose: Redis's `appendfsync always` (safe, slower), `everysec` (lose up to ~1 second on a crash, the default), or `no` (let the OS decide). Knowing that trade-off is exactly the kind of thing interviewers like.

## Sequential vs random I/O shapes software

Because sequential I/O is so much cheaper, many famous systems are built around **appending** to the end of a file instead of updating in place:

- **Write-ahead logs** in every database.
- **Kafka**: a topic partition is an append-only log on disk; it is fast precisely because it writes and reads sequentially and leans on the page cache (Day 34).
- **LSM trees** (Cassandra, RocksDB): buffer writes in memory, then write big sorted files sequentially (Day 19).

## The math

**HDD random vs sequential.** Reading 4 KB blocks randomly at 10 ms each:

```text
100 IOPS × 4 KB = 400 KB/s  random
sequential:       200 MB/s
ratio: 200,000 / 400 = 500× faster sequentially
```

**A million random reads:**

```text
HDD  at 100 IOPS:       10^6 / 100     = 10,000 s ≈ 2.8 hours
NVMe at 500,000 IOPS:   10^6 / 500,000 = 2 s
```

**fsync caps commit rate.** If each commit waits for its own fsync of 5 ms on an HDD:

```text
max commits/s = 1 / 0.005 = 200
with group commit, 50 transactions per fsync: 200 × 50 = 10,000 commits/s
```

**Tiny files waste space.** 50 million thumbnails averaging 1 KB, with 4 KB blocks:

```text
logical: 50 × 10^6 × 1 KB = 50 GB
on disk: 50 × 10^6 × 4 KB = 200 GB   (plus 50 million inodes)
```

This is one reason object stores (Day 36) and databases pack many small things into big files.

## In an interview

- "When is a write durable?" After `fsync` returns (or the DB's commit, which fsyncs its log), not after `write()`.
- "Why is Kafka fast?" Sequential appends, page cache, batching, zero-copy.
- "HDD or SSD for this database?" SSD for random-access workloads; HDD for cheap, large, sequential/cold data.
- "The disk is full but I can't find the files." Deleted files held open by a process.

A good one-paragraph answer on durability: *"A `write()` only puts data in the OS page cache; it reaches disk later. To survive power loss you must `fsync`, which costs anywhere from tens of microseconds to milliseconds. Databases make this affordable by appending to a sequential write-ahead log and batching many commits into one fsync (group commit). Systems that skip fsync per write, like Redis's `everysec`, trade up to a second of data loss for throughput."*

## Common mistakes

- **"write() means saved."** It means "in the page cache". Durability needs `fsync`.
- **"SSDs make random I/O free."** Much cheaper, not free; sequential still wins, and writes wear the drive.
- **"File names live in the file."** They live in directory entries; inodes hold metadata.
- **"Free RAM is wasted RAM, so the page cache is a leak."** The page cache is evicted instantly when programs need memory.
- **Mixing up IOPS and throughput.** 100 IOPS of 4 KB is 400 KB/s; 100 IOPS of 1 MB is 100 MB/s.

## Before moving on

- [ ] I can explain why an HDD does ~100 random reads per second but streams 200 MB/s
- [ ] I can explain what an inode holds and what a directory is
- [ ] I can explain the page cache and why `write()` isn't durable
- [ ] I can describe the temp-file + fsync + rename pattern
- [ ] I can explain why logs and databases love sequential appends

## Go deeper (optional)

- [Hard disk drive performance characteristics — Wikipedia](https://en.wikipedia.org/wiki/Hard_disk_drive_performance_characteristics)
- [Inode — Wikipedia](https://en.wikipedia.org/wiki/Inode)
- [Page cache — Wikipedia](https://en.wikipedia.org/wiki/Page_cache)
- [Node.js fs documentation](https://nodejs.org/api/fs.html)
- *Operating Systems: Three Easy Pieces*, the Persistence part
- *Designing Data-Intensive Applications*, chapter 3
