# Mock Interview and What's Next

> You've gone from bits and bytes to distributed key-value stores. Today you put it all together the way an interview does: one open prompt, 45 minutes, a clock, and nobody to tell you what comes next. Then you grade yourself honestly and plan what to learn after Day 67.

## The big idea

Musicians don't get good by reading about scales; they get good by playing pieces start to finish, recording themselves, and listening back. A mock interview is that recording. It shows you things reading never will: where you freeze, where you ramble, which numbers you can't produce on the spot, and which building blocks you actually understand versus merely recognize.

The plan for today:

1. **Set up** (5 minutes).
2. **Do the mock**, timed, out loud (45 minutes).
3. **Review** with the rubric below (15 minutes).
4. **Plan** your next month.

## Set up

- A timer, blank paper or a whiteboard tool (Excalidraw works well), and a way to **record your voice**. Speaking is the skill; silent thinking doesn't count.
- Put Day 55's framework on a sticky note: *requirements 5 · estimates 5 · API 5 · data model 5 · high-level 10 · deep dives 12 · wrap-up 3*.
- Don't reread the case studies first. You want to find out what you know *now*.
- If a friend can play interviewer, give them the "interviewer card" below and let them answer your questions. Otherwise, answer from the card only when you ask the question out loud.

## The prompt

> **"Design a ticket booking system for concerts, like Ticketmaster."**

That's all an interviewer would say. Start the timer.

<details><summary>Interviewer card: answers to clarifying questions (open only when you ask)</summary>
• Users browse events, pick specific seats on a seat map, and pay. General admission exists too, but focus on reserved seats.<br>• Scale: 100M monthly users, ~10,000 events a day worldwide. Most events are calm.<br>• The hard part: superstar on-sales. Example: 50,000 seats, 2 million fans arrive at 10:00:00.<br>• A seat must never be sold twice. Users get about 10 minutes to pay once they pick seats.<br>• Payment goes through an external payment provider (assume Day 65 exists).<br>• Fairness matters: roughly first come, first served; bots are a known problem.<br>• Out of scope: resale marketplace, recommendations, venue management tools.
</details>

### Follow-up curveballs (use them in the last 15 minutes)

If you have a partner, they should throw these at you. Solo, pick two at random when you reach the deep dives:

1. "Two users click the same seat in the same millisecond. Walk me through exactly what happens."
2. "The payment provider is down for 5 minutes during the on-sale. What happens to held seats?"
3. "Traffic at 10:00:00 is 50× normal. Which component dies first?"
4. "How do you stop a bot farm from grabbing all the front rows?"
5. "A user's phone dies right after paying. How do they know they have tickets?"

## Running the 45 minutes

Here's what a good session sounds like, minute by minute. Glance at it before you start, then put it away.

| Clock | You're doing | Say something like |
|---|---|---|
| 0–5 | Requirements | "Before I design, let me make sure I build the right thing. Who are the users, and what's the hardest moment for this system?" |
| 5–10 | Estimates | "Let me size the on-sale spike, since that drives everything." Write the numbers down where you can point at them. |
| 10–15 | API | "Three core calls: view seats, hold seats, book. Booking takes an idempotency key." |
| 15–20 | Data model | "Seats are the contested resource, so a seat row has a status and a hold expiry, partitioned by event." |
| 20–28 | High-level design | Draw left to right: client → CDN → waiting room → gateway → services → database. Trace one user end to end. |
| 28–40 | Deep dives | "The two hardest parts are never double-selling a seat and surviving the spike. Let me start with seats." |
| 40–45 | Wrap-up | "To summarize… The biggest risks are… With more time I'd look at…" |

If you get stuck, say what you're weighing ("I'm deciding between a lock and a conditional update; the conditional update avoids holding locks across a user's think time…"). Silence is the only truly wrong answer.

## Self-review rubric

Listen to your recording, then score each row 0, 1 or 2. Be strict: only give 2 if you'd be happy for an interviewer to hear exactly that.

| Area | 0: missing | 1: partial | 2: strong |
|---|---|---|---|
| **Requirements** | jumped straight to boxes | listed features only | functional + non-functional, named the on-sale spike and "never double-sell" as the core |
| **Estimates** | no numbers | numbers with no conclusion | numbers that changed a decision (e.g. "1M req/s at 10:00 → we need a waiting room") |
| **API** | none | endpoints without semantics | holds vs bookings, idempotency key on booking, pagination where needed |
| **Data model** | vague "a database" | tables without keys | seat rows with status + hold expiry, keyed/partitioned by event |
| **High-level design** | disconnected boxes | works for one user | traced a request end to end: browse, hold, pay, confirm |
| **Deep dive: concurrency** | not addressed | "use a lock" | atomic conditional update or transaction; explained the race and expiry |
| **Deep dive: the spike** | not addressed | "add servers" | waiting room / queue, CDN for static pages, cached seat map, rate limits |
| **Trade-offs** | none | named one | at least three, each with a reason (consistency vs availability, fairness vs throughput…) |
| **Failure handling** | none | one failure mode | payment down, server crash mid-hold, retries with idempotency |
| **Communication** | long silences | talked but didn't check in | drove the session, summarized, managed time, adapted to curveballs |

**Scoring:** 16–20 is interview-ready for this problem. 10–15: solid base; redo the weakest two rows. Under 10: totally normal for a first mock; reread Day 55, then redo this same prompt in a week.

Also answer in writing:

- Where did I go silent for more than 20 seconds? What was I unsure of?
- Which number did I fail to estimate? (Go back to Day 26.)
- Which building block did I name without being able to explain? (That's your next study topic.)
- What time was it when I started the deep dive? (Target: by minute 28.)

## Reference sketch

Only open this after your review. It's one good answer, not *the* answer.

<details><summary>Reference sketch: ticket booking</summary>
<b>Requirements.</b> Browse events, view seat map, hold seats for 10 min, pay, get tickets. Non-functional: never double-sell (strong consistency on seats), survive on-sale spikes, fair ordering, highly available browsing.
<br><br><b>Estimates.</b> 2M fans at 10:00 refreshing every ~2 s ≈ 1M requests/s for one event, versus normal traffic of a few thousand/s. Only 50,000 seats ≈ 20,000 orders at ~2.5 seats each. Writes are tiny; the read and connection spike is the problem. Conclusion: put fans in a waiting room and admit them at a rate the booking path can handle.
<br><br><b>API.</b> GET /events/{id}; GET /events/{id}/seats (cached, a few seconds stale is fine); POST /events/{id}/holds {seatIds} → holdId, expiresAt; POST /bookings {holdId} with Idempotency-Key → pays via payment service; GET /bookings/{id}.
<br><br><b>Data model.</b> seats(event_id, seat_id, status available/held/sold, hold_id, hold_expires_at, version) partitioned by event_id; holds(hold_id, user_id, event_id, expires_at); bookings(booking_id, hold_id UNIQUE, user_id, payment_id, status).
<br><br><b>High-level.</b> CDN for event pages and static seat-map layout (Day 30) → waiting room service issuing signed, time-limited admission tokens → API gateway with per-user rate limits (Day 35) → booking service → SQL database for seats (ACID, Day 22), seat availability cached in Redis for the seat map → payment service (Day 65) → outbox events to ticket delivery and notifications (Day 61).
<br><br><b>Deep dive: holding seats.</b> In one transaction: UPDATE seats SET status='held', hold_id=:h, hold_expires_at=now()+10min WHERE event_id=:e AND seat_id IN (:ids) AND (status='available' OR (status='held' AND hold_expires_at &lt; now())). If rows updated ≠ number of seats requested, roll back and tell the user which seats are gone. Expired holds become available automatically through the WHERE clause; a sweeper also resets them. Confirming a booking requires the hold to still be valid: UPDATE ... SET status='sold' WHERE hold_id=:h AND hold_expires_at &gt; now().
<br><br><b>Deep dive: the spike.</b> Waiting room assigns a random or arrival-ordered position, shows progress, and admits N users/minute based on booking-path capacity (Little's Law: 20,000 concurrent shoppers ÷ 5 min each = 4,000 admissions/min). Once remaining seats are fewer than people ahead, tell the rest early. Bots: CAPTCHA/verified accounts before joining, one token per account, rate limits per IP/device.
<br><br><b>Failures.</b> Payment provider down: extend holds or pause admissions; never sell without a confirmed payment; idempotency keys on booking and payment. Booking server crash: state is in the DB, holds expire on their own. Phone dies: booking is durable; tickets are shown in the account and emailed.
<br><br><b>Trade-offs.</b> Strong consistency for seats vs availability (fine: few writes). Waiting room fairness vs user frustration. Cached seat map may show a seat that's just been taken: the hold call is the source of truth. Sharding by event keeps each on-sale on one partition (a hot partition, but with only ~20,000 orders it fits one primary).
</details>

## What's next

You now know the vocabulary and the main building blocks. The next level comes from **reps** and **depth**.

### 1. Keep practicing designs (2 per week)

Do each one timed, then review with the rubric. Each one leans on days you've studied:

| Problem | Leans on |
|---|---|
| Photo sharing (Instagram) | object storage (36), CDN (30), news feed (57) |
| File sync (Dropbox) | chunking and hashing (25), object storage (36), sync conflicts (64) |
| Nearby places (Yelp) | geohash/quadtree (63), read-heavy caching (29) |
| Rate limiter as a service | token bucket (35), Redis, consistency (40) |
| Leaderboard for a game | sorted sets, sharding (32), caching (29) |
| Distributed job scheduler | queues (34), leader election (42), idempotency (43) |
| Metrics and monitoring system | time-series storage (23), observability (46) |
| Ad-click aggregation | stream processing (34), exactly-once (43) |
| Stock exchange matching engine | latency (05, 52), ordering, single-threaded design |

### 2. Re-review with spacing

Revisit the questions you scored lowest on, 1 day, 1 week, and 1 month later. Short, repeated recall beats long rereads.

### 3. Read the classics

- *Designing Data-Intensive Applications* by Martin Kleppmann: the best single book on this whole course's second half.
- *System Design Interview* Volumes 1 and 2 by Alex Xu: many more worked case studies.
- Papers (each is readable in an evening once you know the vocabulary): Google File System (2003), MapReduce (2004), Bigtable (2006), Dynamo (2007), Raft "In Search of an Understandable Consensus Algorithm" (2014), Spanner (2012).

### 4. Build something small

Nothing makes ideas stick like code. A weekend each: an LRU cache with TTLs, a URL shortener with base62, a chat server with WebSockets, a tiny LSM-tree key-value store that writes SSTables, a consistent-hashing ring with a simulation of node failures. Measure them, break them, and write down what you learned.

## Common mistakes

- **Doing mocks silently in your head.** The interview is spoken; practice speaking.
- **Peeking at the reference first.** You'll recognize it and mistake recognition for knowledge.
- **Polishing the high-level diagram for 30 minutes.** Start the deep dive by minute ~28.
- **Grading generously.** A 1 you fix is worth more than a 2 you imagined.
- **Only doing new problems.** Redoing a weak problem a week later shows real progress.

## Before moving on

- [ ] I did the 45-minute mock out loud and recorded it
- [ ] I scored myself on all ten rubric rows and wrote down my two weakest areas
- [ ] I compared my design with the reference sketch and noted one idea I missed
- [ ] I picked my next two practice problems and put them on my calendar
- [ ] I chose one book or paper and one small project to start

## Go deeper (optional)

- [*Designing Data-Intensive Applications* on O'Reilly](https://www.oreilly.com/library/view/designing-data-intensive-applications/9781491903063/)
- [Raft consensus algorithm site](https://raft.github.io/)
- [Google File System on Wikipedia](https://en.wikipedia.org/wiki/Google_File_System)
- DeCandia et al., *Dynamo: Amazon's Highly Available Key-value Store* (2007)
