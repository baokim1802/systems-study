# How AI Systems Are Served

> Chatbots, code assistants and semantic search are now ordinary parts of system design. Behind the magic is a very large function running on GPUs, and serving it well is a classic systems problem: memory, bandwidth, batching, caching and cost.

## The big idea

Think of a huge, well-read autocomplete. You type "The capital of France is", and it guesses the most likely next word: "Paris". Then it reads "The capital of France is Paris" and guesses again: ".". Word by word, a whole answer appears. A **large language model (LLM)** is exactly that: a function that, given some text, predicts what comes next, run in a loop.

Here's the loop with a toy "model" that only knows which word followed which in a tiny text:

```js
// A "model" that has learned which word tends to follow which.
const text = "the cat sat on the mat the cat ate the fish the dog sat on the log";
const words = text.split(" ");
const next = {};                                  // the model's "weights"
for (let i = 0; i < words.length - 1; i++) {
  if (!next[words[i]]) next[words[i]] = [];
  next[words[i]].push(words[i + 1]);
}

function generate(prompt, maxTokens) {
  const out = prompt.split(" ");
  for (let i = 0; i < maxTokens; i++) {           // one step per new token
    const options = next[out[out.length - 1]];
    if (!options) break;
    out.push(options[Math.floor(Math.random() * options.length)]); // sample
  }
  return out.join(" ");
}
console.log(generate("the dog", 6)); // e.g. "the dog sat on the cat ate the"
```

A real LLM replaces the lookup table with a neural network that has **billions of parameters** and looks at the *whole* preceding text, not just the last word. But the serving shape is the same: **one forward pass per generated token**, in sequence. That sequential loop drives almost every engineering decision below.

## Words you need

| Term | Meaning |
|---|---|
| **Model / weights / parameters** | The learned numbers inside the network. A "7B" model has 7 billion of them. |
| **Training** | Learning the weights from huge amounts of data. Done once, weeks on thousands of GPUs. |
| **Inference** | Using the trained model to produce output. Happens on every request: this is "serving". |
| **Token** | The unit models read and write: a word or a piece of one. In English, 1 token ≈ 4 characters ≈ 0.75 words. |
| **Context window** | The maximum number of tokens (prompt + output) the model can consider at once. |
| **GPU** | A chip with thousands of small cores, built for the matrix multiplications neural networks are made of, with very fast on-board memory (**HBM**, high-bandwidth memory). |

## How inference actually works

A request has two phases:

```text
prompt: "Summarize this article: ...2,000 tokens..."
          │
          ▼
 ┌──────────────────┐   all prompt tokens processed in parallel
 │  1. PREFILL      │   → compute-heavy, fast per token
 └──────────────────┘   → produces the 1st output token
          │                       (time to first token, TTFT)
          ▼
 ┌──────────────────┐   one token per step, each step needs
 │  2. DECODE       │   the previous one → sequential
 │  loop until done │   → memory-bandwidth-heavy
 └──────────────────┘   (time per output token, TPOT)
```

**Why decode is slow:** to produce *each* token, the GPU must read **all the weights** from its memory. A 7B model in 16-bit numbers is `7 × 10^9 × 2 bytes = 14 GB`. Reading 14 GB per token is the bottleneck, not the arithmetic.

**The KV cache.** To avoid recomputing the whole prompt at every step, the model stores intermediate results for each previous token (the "keys" and "values" of its attention layers). That's the **KV cache**, and it lives in GPU memory, growing with every token of every active conversation.

## The math

### Does the model fit?

```text
bytes = parameters × bytes per parameter
7B  at 16-bit (2 bytes)  = 14 GB    → fits on one 80 GB GPU with room to spare
70B at 16-bit            = 140 GB   → needs at least 2 × 80 GB GPUs (split the model)
70B at 4-bit (0.5 bytes) = 35 GB    → fits on one GPU: that's "quantization"
```

**Quantization** stores weights with fewer bits (8 or 4 instead of 16), trading a little quality for less memory and faster decode.

### How fast can one conversation decode?

An NVIDIA H100 GPU reads its memory at about 3.35 TB/s.

```text
time per token ≥ 14 GB / 3,350 GB/s ≈ 4.2 ms   → at most ~240 tokens/s for one user
```

### Batching changes everything

The weights are read once per step whether that step serves 1 conversation or 32. So run 32 conversations together: each step reads 14 GB once and produces 32 tokens.

```text
batch 1:  ~240 tokens/s total
batch 32: up to ~32 × 240 ≈ 7,700 tokens/s total (until compute or KV-cache reads limit it)
```

Same GPU, ~30x the throughput: the latency vs throughput trade-off from Day 52. Modern servers (vLLM, TensorRT-LLM, TGI) use **continuous batching**: as soon as one sequence finishes, a waiting one joins the batch at the next step, instead of waiting for the whole batch to finish.

### What limits the batch? KV-cache memory

For a Llama-2-7B-style model (32 layers, hidden size 4,096, 16-bit):

```text
KV per token = 2 (K and V) × 32 layers × 4,096 × 2 bytes = 524,288 bytes ≈ 0.5 MB
one 4,096-token conversation ≈ 2 GB
GPU: 80 GB − 14 GB weights = 66 GB free → about 33 full-length conversations at once
```

Newer models shrink this with tricks like grouped-query attention, and servers page the KV cache in blocks (vLLM's "PagedAttention") to avoid wasting memory. But the lesson holds: **long contexts are expensive because they eat the memory that batching needs.**

### What does it cost?

Hosted APIs charge per million tokens, with output tokens costing several times more than input (they need the slow decode loop). Say a model costs $3 per million input tokens and $15 per million output tokens (an illustrative price; check current ones):

```text
1 million requests/day × 2,000 input tokens = 2 × 10^9 tokens × $3/M  = $6,000/day
1 million requests/day ×   300 output tokens = 3 × 10^8 tokens × $15/M = $4,500/day
                                                               total ≈ $10,500/day ≈ $3.8M/year
```

Cost levers: shorter prompts, cache repeated prompt prefixes (**prompt caching**), route easy requests to a **smaller, cheaper model**, cap output length, and cache whole answers for repeated questions.

### Latency the user feels

```text
TTFT ≈ 0.3–1 s (queueing + prefill)
500-token answer at 50 tokens/s = 10 s total
```

Ten seconds of spinner is awful, but ten seconds of text appearing is fine. That's why chat apps **stream** tokens to the browser with server-sent events or WebSockets (Day 18).

## Embeddings and vector search

An **embedding model** turns text (or images) into a list of numbers, a **vector**, such that texts with similar *meaning* get vectors pointing in similar directions. "I forgot my login" and "How do I reset my password?" share almost no words, but their vectors are close.

Closeness is usually measured with **cosine similarity**: 1 means same direction, 0 means unrelated.

```js
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
// Toy 3-dimensional "embeddings" (real ones have hundreds or thousands of dims)
const docs = {
  "How do I reset my password?": [0.9, 0.1, 0.0],
  "Refund policy for orders":    [0.1, 0.9, 0.2],
  "Shipping times to Canada":    [0.0, 0.3, 0.9],
};
const query = [0.8, 0.2, 0.1]; // embedding of "I forgot my login"
const ranked = Object.entries(docs)
  .map(([text, vec]) => ({ text, score: cosine(query, vec) }))
  .sort((a, b) => b.score - a.score);
console.log(ranked.map(r => `${r.score.toFixed(2)}  ${r.text}`).join("\n"));
// 0.98  How do I reset my password?
// 0.36  Refund policy for orders
// 0.19  Shipping times to Canada
```

Comparing the query with *every* vector is `O(n × d)`. With 1 million documents of 1,536 dimensions, that's 1.5 billion multiply-adds per query: too slow at scale. **Vector databases** (pgvector, Pinecone, Milvus, FAISS-based systems) use **approximate nearest neighbor (ANN)** indexes such as **HNSW**, a layered graph you hop through toward closer vectors, answering in milliseconds while occasionally missing the true best match. Storage: `1,000,000 × 1,536 × 4 bytes ≈ 6 GB` of raw floats.

## RAG: giving the model your data

Models only know what was in their training data. **Retrieval-augmented generation (RAG)** looks up relevant documents at question time and pastes them into the prompt:

```text
 OFFLINE (indexing)                         ONLINE (each question)
 docs → split into chunks (~500 tokens)     question
      → embedding model                        → embed question
      → vector DB (+ chunk text, metadata)      → vector DB: top-k similar chunks (k≈5)
                                               → (optional) keyword search + re-rank
                                               → prompt = instructions + chunks + question
                                               → LLM → streamed answer with citations
```

Design choices interviewers probe: chunk size (too big wastes context, too small loses meaning), combining vector and keyword search (**hybrid search**, since exact names and error codes match better by keyword, Day 37), keeping the index fresh when documents change, permissions (never retrieve chunks the user isn't allowed to see), and evaluating answer quality.

## In an interview

An "AI feature" question is mostly a normal design question with a slow, expensive, GPU-bound dependency in the middle. Talk about: streaming responses, a queue and rate limits in front of the GPUs, batching for throughput, autoscaling GPU pools (slow to start, expensive to idle), caching, routing to smaller models, timeouts and fallbacks, and the token-cost math.

A crisp summary: "LLM inference is a prefill step followed by a sequential decode loop that is memory-bandwidth bound, so we batch many requests per GPU with continuous batching; the KV cache limits batch size, so long contexts cost throughput. We stream tokens to cut perceived latency, use RAG with a vector index for private data, and control cost with prompt caching, smaller models for easy requests, and output caps."

## Common mistakes

- **Treating an LLM call like a 50 ms database call.** It's seconds, and costs real money per request.
- **Ignoring output tokens.** They're slower and pricier than input tokens.
- **"Just put all the docs in the prompt."** Context is limited and every token costs; retrieve what's relevant.
- **Forgetting access control in RAG.** The vector index must respect who can see what.
- **Assuming GPUs autoscale like web servers.** They're scarce, slow to start and expensive to leave idle.

## Before moving on

- [ ] I can explain tokens, prefill vs decode, and why decode is sequential
- [ ] I can estimate model memory from parameter count and bytes per parameter
- [ ] I can explain why batching raises throughput and what the KV cache limits
- [ ] I can compute a daily token bill
- [ ] I can draw the RAG pipeline and explain cosine similarity

## Go deeper (optional)

- [Large language model (Wikipedia)](https://en.wikipedia.org/wiki/Large_language_model)
- Vaswani et al., "Attention Is All You Need" (2017), the Transformer paper
- Kwon et al., "Efficient Memory Management for Large Language Model Serving with PagedAttention" (2023), the vLLM paper
- Lewis et al., "Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks" (2020)
- [Hierarchical navigable small world (Wikipedia)](https://en.wikipedia.org/wiki/Hierarchical_navigable_small_world)
