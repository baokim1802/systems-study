# Start Here: How to Learn Systems

> Every app you use (Instagram, Google Maps, your bank) is a **system**: many computers, programs and networks working together. Learning how they work makes you a better engineer, and it's what system design interviews test. Today you learn how this space works and how to think and answer like an engineer.

## How this space works

Every day has one topic and three steps:

| Step | Where | What you do |
|---|---|---|
| 📖 **Read** | the Read tab | One lesson, about 15–25 minutes. Analogy first, then the real mechanism, then the numbers. |
| ✍️ **Answer** | the Answer tab | 5–6 interview-style questions. Write in your own words. Answers save as you type. |
| 🤖 **Get feedback** | the Feedback tab | An AI grades each answer 0–10 against a checklist, shows a model answer and asks a follow-up. |

Then you **mark the day finished**. Its questions join your 🧠 **Recall** deck and come back 1, 3, 7, 14, 30 and 60 days later. Answering from memory on a schedule (called *spaced repetition*) is one of the best-tested ways to remember things for the long term.

### Getting feedback, two ways

1. **Any AI.** Click **📋 Copy prompt for AI**. It copies your answers, the questions, and a grading checklist. Paste it into Claude (or any chat AI). Paste the reply into the 🤖 Feedback tab. The reply ends with a line like `SCORES: q1=7, q2=5`, which records your scores.
2. **Claude Code.** In a terminal in this folder, run `/grade 1` (or just say "grade day 1"). Claude reads `answers/01-start-here.json`, grades it, and writes the feedback back into the file. Switch back to the browser and it appears.

Everything lives in plain files, so nothing is locked inside the app:

```text
systems/
├── days/NN-topic/
│   ├── lesson.md        ← the reading
│   └── day.json         ← the questions + grading checklist
├── answers/NN-topic.json ← YOUR answers, feedback and scores
├── cheatsheets/         ← quick references (the 📝 drawer, Ctrl+/)
└── data/progress.json   ← streaks, recall schedule, goals
```

## The map

67 days in seven tracks. Each one builds on the last.

| Track | Days | You'll be able to… |
|---|---|---|
| 🧠 How a computer works | 1–10 | explain what actually happens when code runs: bits, CPU, memory, OS, threads, disks |
| 🌐 Networking | 11–18 | trace a web request from your keyboard to a server and back |
| 🗄️ Data & databases | 19–25 | choose and design a database, and explain indexes and transactions |
| 🧱 Building blocks of scale | 26–37 | use caches, load balancers, replication, sharding, queues, CDNs |
| 🕸️ Distributed systems | 38–45 | reason about failures, consistency, clocks and consensus |
| 🛠️ Production | 46–54 | talk about security, deploys, monitoring, cloud costs, and how AI is served |
| 🏗️ Design case studies | 55–67 | design real systems (URL shortener, chat, feeds, video…) in a 45-minute interview |

> You don't need to be "a math person". The math here is mostly multiplying big numbers and powers of two, and every lesson works it through step by step.

## What "system design" means

When an interviewer says *"Design Twitter"*, they don't want you to build Twitter. They want to watch how you **think**:

- Do you ask what it must do before designing? (*Requirements*)
- Do you know roughly how big it is? (*Estimation*: 300 million users, how many requests a second?)
- Can you sketch the parts and how data flows between them? (*Architecture*)
- Do you know the building blocks and when to use each? (*Caches, queues, databases…*)
- Do you notice what breaks and say what you're trading away? (*Trade-offs*)

There's rarely one right answer. There are **trade-offs**: every choice makes something better and something else worse. Saying the trade-off out loud is the most important habit you'll build here.

## How to answer interview questions

Use this shape for almost any answer:

1. **Say the core idea in one sentence.** *"A cache keeps a copy of data somewhere faster so we don't redo slow work."*
2. **Explain how it works.** The mechanism, step by step.
3. **Give an example or a number.** *"Reading RAM takes about 100 nanoseconds. A database query over the network is about 1 millisecond, 10,000 times slower."*
4. **Name the trade-off or failure case.** *"…but cached data can be stale, so we need a TTL or invalidation."*

Answers that do all four sound senior, even when they're short.

### A worked example

**Question:** *Why do websites load faster the second time you visit?*

> **Weak:** "Because of caching."
>
> **Strong:** "Because the browser keeps copies of files it already downloaded, which is called caching. On the first visit it downloads the HTML, CSS, JavaScript and images, maybe 2 MB. The server sends headers like `Cache-Control: max-age=86400` that say how long each file can be reused. On the second visit the browser reads those files from local disk in a millisecond or so instead of fetching them over the network, which can take hundreds of milliseconds. It also skips repeated DNS and connection setup. The trade-off: if the site changes, you might see an old version until the cache expires, which is why sites put a version hash in file names like `app.3f9a.js`."

Same knowledge, very different impression. The strong answer has a definition, the mechanism, numbers, and a trade-off.

## Thinking in numbers

Engineers estimate constantly. A few numbers to start with (they get a full lesson on Day 5 and Day 26):

```text
1 KB  = 1,000 bytes      (a short email)
1 MB  = 1,000 KB         (a photo is ~2-5 MB)
1 GB  = 1,000 MB         (an HD movie is ~4 GB)
1 TB  = 1,000 GB

1 day ≈ 86,400 seconds   ≈ 100,000 for quick math
1 million requests/day   ≈ 12 requests/second
```

**Try it:** an app has 10 million users who each open it 5 times a day. How many requests per second is that, on average?

```text
10,000,000 × 5 = 50,000,000 requests per day
50,000,000 / 100,000 seconds ≈ 500 requests per second
```

Peak traffic is often 2–3× the average, so plan for about 1,000–1,500 per second. You just did a back-of-the-envelope estimate. 🎉

## A little code: measuring time

You'll see small JavaScript snippets in many lessons. You can run them in your browser's console (F12 → Console) or with `node`. This one shows how much faster it is to look something up in a `Map` than to search an array:

```js
const N = 1_000_000;
const arr = Array.from({ length: N }, (_, i) => i);
const map = new Map(arr.map((x) => [x, true]));

let t = performance.now();
arr.includes(N - 1);              // checks every element: O(n)
console.log('array:', (performance.now() - t).toFixed(3), 'ms');

t = performance.now();
map.has(N - 1);                   // jumps straight to it: O(1)
console.log('map:  ', (performance.now() - t).toFixed(3), 'ms');
```

The idea behind that gap, choosing the right structure so you do less work, is the same idea behind indexes, caches and most of system design.

## How to study

- **Daily beats binge.** 30–45 minutes a day for 67 days beats three long weekends. The streak counter is there to help.
- **Answer before peeking.** Struggling to recall is what makes memory stick. Use 💡 Hint first, 🔑 Key points last.
- **Guess, then get corrected.** A wrong answer plus feedback teaches more than a blank one.
- **Say it out loud.** Interviews are spoken. Explain answers to a rubber duck, a friend, or yourself.
- **Do the Recall cards.** A few minutes on most days. That's how Day 3 is still in your head on Day 60.
- **Ask follow-ups.** When feedback mentions something you don't know, ask the AI. Curiosity is the whole job.

## Before moving on

- [ ] I know the three steps of a day: read, answer, get feedback
- [ ] I tried copying the prompt for AI (or `/grade 1` in Claude Code)
- [ ] I can say what a trade-off is, with an example
- [ ] I can estimate requests per second from daily users
- [ ] I set my name, weekly goal and target date in 🎯 Goals

## Go deeper (optional)

- [Latency Numbers Every Programmer Should Know](https://gist.github.com/jboner/2841832) (we'll cover these on Day 5)
- *Designing Data-Intensive Applications* by Martin Kleppmann, the classic book behind a lot of this curriculum
- [Spaced repetition](https://en.wikipedia.org/wiki/Spaced_repetition) on Wikipedia, the method behind 🧠 Recall
