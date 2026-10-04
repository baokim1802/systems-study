# Search and Inverted Indexes

> A database index finds rows by exact value. Search finds documents by the *words in them*, ranked by how well they match, across billions of pages in milliseconds. The trick behind it is the same one at the back of every textbook.

## The big idea

Open a thick biology textbook and look for "mitochondria". You don't read all 900 pages. You flip to the **index** at the back:

```text
mitochondria ......... 45, 112, 113, 380
mitosis .............. 201, 202
```

That's an **inverted index**: instead of "page → words on it" (the book itself, the *forward* index), it stores "word → pages containing it". It's called *inverted* because it flips the direction.

Every search engine, from Google to the search box in your email, Elasticsearch, Apache Lucene and Postgres full-text search, is built on this idea.

Why can't a normal database do it? `WHERE body LIKE '%mitochondria%'` can't use a B-tree index (Day 21), because the word could be anywhere in the text. It has to scan every row: `O(total text)`. An inverted index makes it a single lookup.

## How it actually works

### Step 1: Turn text into terms (analysis)

Before indexing, text goes through an **analyzer**, a small pipeline:

1. **Tokenize**: split into words. `"Quick, brown foxes!"` → `Quick`, `brown`, `foxes`.
2. **Normalize**: lowercase, strip accents. `Quick` → `quick`, `café` → `cafe`.
3. **Remove stop words** (optional): very common words like `the`, `a`, `of`, which match almost everything.
4. **Stem**: chop words to a root so variants match. `foxes` → `fox`, `running` → `run`.

The resulting words are called **terms**. The crucial rule: **the query goes through the same analyzer as the documents**. Otherwise the user's `Foxes` never matches the indexed `fox`.

### Step 2: Build the index

For each term, keep a **postings list**: the sorted list of document ids containing it (often with extra info such as how many times it appears and at which positions).

```js
const docs = {
  1: "The quick brown fox",
  2: "The lazy dog sleeps",
  3: "A quick dog runs, the fox watches",
};

const STOP = new Set(["the", "a", "an", "and", "of"]);

function tokenize(text) {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(t => t && !STOP.has(t));
}

function buildIndex(docs) {
  const index = new Map();                      // term → [docIds]
  for (const [id, text] of Object.entries(docs)) {
    for (const term of new Set(tokenize(text))) {
      if (!index.has(term)) index.set(term, []);
      index.get(term).push(Number(id));         // ids arrive in order → lists stay sorted
    }
  }
  return index;
}

const index = buildIndex(docs);
// quick → [1, 3]   fox → [1, 3]   dog → [2, 3]   brown → [1]   lazy → [2] ...
```

### Step 3: Answer a query

A query like `quick fox` (meaning both words) becomes: fetch both postings lists and **intersect** them. Because they're sorted, two pointers walk them in one pass, the same trick as merging in merge sort:

```js
function intersect(a, b) {
  const out = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push(a[i]); i++; j++; }
    else if (a[i] < b[j]) i++;
    else j++;
  }
  return out;
}

function search(query) {
  const lists = tokenize(query).map(t => index.get(t) || []);
  if (lists.length === 0) return [];
  lists.sort((a, b) => a.length - b.length);   // start with the rarest term
  return lists.reduce(intersect);
}

console.log(search("quick fox"));  // [1, 3]
console.log(search("Dog"));        // [2, 3]
console.log(search("quick cat"));  // []
```

An `OR` query takes the **union** instead. Starting with the shortest list keeps intermediate results small. The cost is proportional to the lengths of the postings lists, not to the size of the whole collection.

Storing **positions** (`fox` → doc 1 at position 3) enables **phrase queries** like `"brown fox"`: both terms match and their positions are adjacent.

## Ranking: which results come first?

Finding matches is half the job. If 2 million pages contain "pink elephant", which ten go on page one? The classic intuition is **TF-IDF**:

- **TF, term frequency**: a document that mentions "elephant" 8 times is probably more about elephants than one that mentions it once.
- **IDF, inverse document frequency**: rare words carry more meaning. "the" appears everywhere, so matching it tells you nothing; "elephant" is rare, so matching it says a lot.

```text
idf(term) = log10(N / df)       N = total documents, df = documents containing the term
score(doc) = Σ over query terms of  tf(term, doc) × idf(term)
```

Modern engines (Lucene, Elasticsearch) use **BM25**, a refined TF-IDF where repeating a word has diminishing returns (the 20th "elephant" adds little) and long documents don't win just by being long. On top of text relevance, real systems blend in other signals: freshness, popularity, click-through, personalization, and nowadays **semantic** (vector) similarity from embeddings (Day 54).

## Making it fast and fresh: segments

Rewriting a giant index file on every new document would be hopeless. Lucene, the library inside Elasticsearch and OpenSearch, uses an idea you saw with LSM trees (Day 19):

- New documents are buffered in memory and periodically written out as a small **immutable segment** (a mini inverted index).
- A search checks all segments and merges the results.
- Background **merging** combines small segments into bigger ones.
- Deletes are just markers ("doc 17 is dead"), cleaned up during merges.

Elasticsearch makes new documents searchable on a **refresh**, every 1 second by default. That's why it's called **near-real-time** search: write, then about a second later, it shows up.

## Scaling out: Elasticsearch-style sharding

One machine can't hold the index of billions of documents. Elasticsearch splits an **index** into **shards**, each a complete Lucene index for a subset of documents, and keeps **replica** copies of each shard on other nodes (Day 31).

```text
            query "pink elephant", top 10
                         │
                 ┌───────▼────────┐
                 │ coordinating   │
                 │ node           │
                 └─┬─────┬─────┬──┘
     scatter       ▼     ▼     ▼
             shard 0  shard 1  shard 2     each returns its own top 10 (id + score)
                 │     │     │
     gather      └─────┼─────┘
                 merge 30 candidates → global top 10 → fetch those 10 documents
```

This is **document partitioning**: each shard indexes whole documents, so every query must ask every shard (**scatter-gather**). The slowest shard sets the response time, so tail latency (Day 46) matters a lot here. Deep pagination is expensive: page 1,000 of 10 results means each shard must produce its top 10,000.

The alternative, **term partitioning** (shard A holds terms a–m, shard B holds n–z), means a query hits only the shards for its terms, but multi-word queries need cross-shard intersections of huge lists, and popular terms make hot spots. Most systems choose document partitioning.

Search engines are usually a **secondary** system: the source of truth stays in your main database, and changes flow into the search index through a queue or change data capture (Day 34). If the index is lost, you rebuild it.

## The math

```text
TF-IDF with N = 1,000,000 documents
  "pink"     appears in 100,000 docs → idf = log10(1,000,000 / 100,000) = 1
  "elephant" appears in   1,000 docs → idf = log10(1,000,000 / 1,000)   = 3
  "the"      appears in all docs     → idf = log10(1) = 0   (useless for ranking)

Query: "pink elephant"
  Doc A: pink ×3, elephant ×1 → 3×1 + 1×3 = 6
  Doc B: pink ×1, elephant ×2 → 1×1 + 2×3 = 7   ← ranks higher: more of the rare word

Index size estimate: 100 million docs × 500 terms each, postings ~ 2 bytes per entry
  after compression → ~100 GB of postings, split into e.g. 10 shards of 10 GB
```

## In an interview

Search appears in designs like "search tweets", "product search", "typeahead" (Day 62) or "search Slack messages". Interviewers want to hear:

- **Inverted index**, and why `LIKE '%x%'` doesn't scale.
- Analysis: tokenize, lowercase, stem, the same on queries.
- How ranking works at a high level (TF-IDF/BM25 plus business signals).
- Sharding by document with scatter-gather, replicas for read throughput.
- How data gets in: DB as source of truth, async indexing, near-real-time lag.

Good paragraph: "Posts live in our primary DB. A change stream publishes post events to Kafka, and indexer workers write them into an Elasticsearch index sharded by document, with one replica per shard. Queries go to a coordinating node that scatters to all shards, each returning its BM25 top-k, then merges and re-ranks with recency and engagement. New posts are searchable within about a second."

## Common mistakes

- **Using the primary database with `LIKE`** for full-text search at scale.
- **Analyzing documents and queries differently**, so obvious matches fail.
- **Treating the search index as the source of truth**. It's a derived view.
- **Forgetting that every query hits every shard**: more shards isn't free.
- **Assuming instant visibility**: indexing is near-real-time, not synchronous.

## Before moving on

- [ ] I can explain an inverted index with the textbook analogy
- [ ] I can build a tiny inverted index and do AND queries by intersecting sorted lists
- [ ] I can compute a TF-IDF score by hand
- [ ] I can draw scatter-gather over document-partitioned shards
- [ ] I can explain why search is near-real-time

## Go deeper (optional)

- [Wikipedia: Inverted index](https://en.wikipedia.org/wiki/Inverted_index)
- [Wikipedia: tf–idf](https://en.wikipedia.org/wiki/Tf%E2%80%93idf)
- [Wikipedia: Okapi BM25](https://en.wikipedia.org/wiki/Okapi_BM25)
- *Introduction to Information Retrieval* by Manning, Raghavan and Schütze (free online from Stanford)
- [Elasticsearch Guide](https://www.elastic.co/guide/en/elasticsearch/reference/current/index.html)
