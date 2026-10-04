# Git Internals

> You use Git every day, but under the commands is a tiny, beautiful database: files named by the hash of their contents. Understanding it makes Git stop being scary, and it teaches an idea (content addressing) that powers caches, CDNs, backups, blockchains and distributed databases.

## The big idea

Imagine a library where every book's shelf label is a **fingerprint of the book's text**. Two identical copies get the same label, so the library stores only one. If anyone changes a single comma, the fingerprint changes, so the label tells you instantly if a book was tampered with. And a "reading list" is just a page of labels, which itself has a fingerprint.

That's Git:

- The fingerprint is a **hash** (Day 25): SHA-1, 40 hex characters, like `ce013625030ba8dba906f756967f9e9ca394464a`.
- Storing data under the hash of its own content is called **content-addressed storage**.
- A commit is a "reading list" of hashes, and it has a hash too.

Everything else (branches, merges, rebases) is moving labels around on top of this.

## The four kinds of objects

Git's database lives in `.git/objects`. It holds only four kinds of objects:

| Object | Holds | Analogy |
|---|---|---|
| **blob** | the bytes of one file (no name, no permissions) | a page of text |
| **tree** | a directory listing: names → blob or tree hashes | a table of contents |
| **commit** | one tree hash, parent commit hash(es), author, date, message | a dated snapshot with a note |
| **tag** (annotated) | a pointer to a commit plus a name, tagger, message | a sticker on a snapshot |

### A blob's hash, by hand

Git hashes the header `blob <size>\0` followed by the content. You can reproduce it in Node:

```js
const crypto = require("crypto");

function gitBlobHash(content) {
  const body = Buffer.from(content, "utf8");
  const header = Buffer.from(`blob ${body.length}\0`, "utf8");
  return crypto.createHash("sha1").update(Buffer.concat([header, body])).digest("hex");
}

console.log(gitBlobHash("hello\n"));
// ce013625030ba8dba906f756967f9e9ca394464a
```

And Git agrees:

```text
$ printf 'hello\n' | git hash-object --stdin
ce013625030ba8dba906f756967f9e9ca394464a
```

Every "hello\n" file in every Git repository on Earth has that hash. That's content addressing.

### Looking inside a real repo

A repo with `hello.txt` and `src/app.js`, after one commit:

```text
$ git cat-file -p HEAD
tree c75719e89f1c69d353ac7eebce85faabae49ef7b
author Kim <kim@example.com> 1767225600 +0000
committer Kim <kim@example.com> 1767225600 +0000

first commit

$ git cat-file -p c75719e
100644 blob ce013625030ba8dba906f756967f9e9ca394464a	hello.txt
040000 tree d147b77712efd2da9d7b3619f3c2782e3a81c587	src
```

The objects form a tree of hashes:

```text
commit b510380
   │
   ▼
tree c75719e ──── hello.txt → blob ce01362 ("hello\n")
   │
   └──── src/ → tree d147b77 ──── app.js → blob 1ac74b4
```

The files on disk are `.git/objects/ce/013625030ba8...` (first two hex characters become a folder), compressed with zlib.

### Why this design is clever

1. **Snapshots are cheap.** A commit is a *full snapshot*, not a diff. But if you change one file, only that blob, its parent trees, and the commit are new. Every unchanged file reuses its existing blob hash.
2. **Integrity for free.** A commit's hash covers its tree hash, which covers every file's hash, and its parent's hash, which covers all of history. Change one byte anywhere in the past and every later hash changes. This structure, a tree where each node's hash covers its children, is a **Merkle tree** (you'll meet it again on Day 66 for syncing replicas).
3. **Deduplication.** The same content is stored once, however many times it appears.
4. **Fast comparison.** Two directories with the same tree hash are identical; Git can skip them without looking inside. That's how `git status` and `git diff` stay fast.

## Branches are just pointers

A **branch** is a tiny file containing one commit hash:

```text
$ cat .git/refs/heads/main
b510380122dab6e24b48caac602c02511f8ff89e

$ cat .git/HEAD
ref: refs/heads/main
```

- **HEAD** says "which branch am I on". It usually points to a branch, which points to a commit.
- `git commit` creates a commit whose parent is the current commit, then moves the current branch pointer to it.
- `git branch feature` creates a new 41-byte file. That's why branches are instant and free.
- **Detached HEAD** means HEAD holds a commit hash directly instead of a branch name. New commits there aren't on any branch, and can be lost when you switch away.

```text
A ← B ← C        ← main ← HEAD
         ↖
          D ← E  ← feature
```

Arrows point *backwards*: each commit knows its parent, never its children. History is a **DAG** (directed acyclic graph).

## Merging vs rebasing

Two ways to combine `feature` (D, E) with `main`, which gained F after you branched:

```text
          D ← E          feature
         ╱
A ← B ← C ← F            main
```

**Merge** (`git checkout main && git merge feature`) does a **three-way merge**: it finds the **merge base** (the last common ancestor, C), compares C→F and C→E, combines both sets of changes, and creates a new commit M with **two parents**.

```text
          D ← E
         ╱      ╲
A ← B ← C ← F ←  M       main
```

If the two sides changed the same lines differently, you get a **conflict** to resolve by hand. If `main` hadn't moved (no F), Git just slides the `main` pointer forward to E: a **fast-forward**, no new commit.

**Rebase** (`git checkout feature && git rebase main`) *replays* your commits on top of F, creating **new** commits D′ and E′ with the same changes but a different parent:

```text
A ← B ← C ← F ← D′ ← E′   feature
```

D′ has a different parent than D, so it has a **different hash**. Rebase doesn't move commits; it copies them and abandons the originals.

| | Merge | Rebase |
|---|---|---|
| History | true history, with merge commits | linear, as if work happened in sequence |
| Rewrites commits? | no | yes (new hashes) |
| Safe on shared branches? | yes | no: others still have the old commits |
| Conflicts | resolved once | may be resolved once per replayed commit |

The golden rule: **don't rebase commits other people have already pulled.** Their copies point at D and E; yours at D′ and E′. Git sees them as different work and things get messy.

## Nothing is really lost: the reflog

Since commits are immutable and branches are pointers, "losing" work usually means "no pointer reaches it". `git reflog` records every place HEAD has pointed recently (kept for about 90 days by default), so after a bad reset or rebase you can find the old hash and `git branch rescue <hash>`. Unreachable objects are eventually deleted by **garbage collection** (`git gc`), the same mark-and-sweep idea as Day 10.

## Storage: packfiles

Storing every version of a big file as a full compressed blob would waste space. Periodically Git packs objects into a **packfile**, storing similar objects as **deltas** (differences) against each other. So the *model* is snapshots, while the *storage* uses diffs. When you `git push` or `git fetch`, Git figures out which objects the other side lacks (by walking hashes) and sends a packfile of just those.

## The math: can two files collide?

SHA-1 has `2^160` possible outputs. By the birthday paradox (Day 25), with `n` random objects:

```text
P(any collision) ≈ n² / 2^161

n = 1 billion objects = 10^9
P ≈ 10^18 / 2.9 × 10^48 ≈ 3.4 × 10^-31
```

Accidental collisions are not a real concern. *Deliberate* ones are: in 2017 researchers produced two different PDFs with the same SHA-1 ("SHAttered"). Git added collision detection, and supports SHA-256 repositories as the long-term fix.

## Why system designers care

Content addressing shows up everywhere:

- **Docker image layers** (Day 49) are identified by SHA-256 digests; identical layers are shared.
- **CDN and browser caching**: files named `app.3f9a2c1.js` can be cached forever, because a new version gets a new name (Day 30).
- **Deduplicating storage and backups** store each unique chunk once by hash.
- **Merkle trees** let replicas or peers find which data differs by comparing a few hashes (Day 66, and in IPFS and blockchains).

## In an interview

Git internals come up as a curiosity question ("what is a branch, really?") or as a design question in disguise: "design a version control system" or "design Dropbox's sync". The ideas to reach for: immutable content-addressed objects, Merkle trees to detect differences cheaply, cheap pointers for names, and dedup.

A strong short answer: "Git is a content-addressed object store. Files are blobs named by their SHA-1, directories are trees of hashes, and a commit points to a root tree and its parents, so each commit is a full snapshot that shares unchanged objects with previous ones. Branches are just files holding a commit hash. Merge creates a commit with two parents via a three-way merge from the common ancestor; rebase rewrites commits onto a new base, producing new hashes, so you shouldn't rebase shared history."

## Common mistakes

- **"Git stores diffs."** The model is snapshots; deltas are only a compression trick inside packfiles.
- **"A branch is a copy of the code."** It's a 41-byte pointer.
- **"Rebase moves my commits."** It creates new commits; the old ones still exist until garbage collected.
- **Panicking after a bad reset.** Check `git reflog` first.

## Before moving on

- [ ] I can name Git's four object types and what each contains
- [ ] I can compute a blob hash in JavaScript
- [ ] I can explain why changing one old commit changes every later hash
- [ ] I can explain merge vs rebase, fast-forward, and why not to rebase shared branches
- [ ] I can name two other systems that use content addressing

## Go deeper (optional)

- [Pro Git, chapter 10: Git Internals](https://git-scm.com/book/en/v2/Git-Internals-Plumbing-and-Porcelain) (free online)
- [Merkle tree (Wikipedia)](https://en.wikipedia.org/wiki/Merkle_tree)
- [Content-addressable storage (Wikipedia)](https://en.wikipedia.org/wiki/Content-addressable_storage)
