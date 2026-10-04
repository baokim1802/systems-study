# Design a Notification System

> "Your order shipped." "Your code is 482913." "Anna liked your photo." Almost every product sends notifications, and almost every company has been burned by one sent twice, sent at 3 a.m., or not sent at all. This design is mostly about queues, retries and respect for the user.

## The big idea

Think of a company mailroom. Departments drop off envelopes (the **producers**: orders, security, marketing). The mailroom checks each recipient's instructions ("no mail on weekends", "email only, no phone calls"), sorts envelopes into bins per courier (post, fax, motorcycle courier: **push, email, SMS**), and couriers carry them out. If a courier comes back saying "nobody home", the envelope goes back in the bin to try later. And an urgent legal letter never waits behind 10,000 flyers.

That's the design: an **intake API**, a **queue**, **routing by user preferences**, **per-channel queues and workers**, and **third-party providers** that do the last mile:

| Channel | Provider (examples) | Typical cost |
|---|---|---|
| iOS push | APNs (Apple Push Notification service) | free |
| Android push | FCM (Firebase Cloud Messaging) | free |
| Email | Amazon SES, SendGrid, Mailgun | ~$0.10 per 1,000 on SES |
| SMS | Twilio, Vonage | ~$0.008 per US message, more abroad |

You never deliver to a phone yourself: you hand the message to Apple, Google or an SMS carrier gateway and they deliver it.

## Step 1: Clarify requirements

**Functional**

- Internal services trigger notifications: transactional ("order shipped", one-time passcodes) and marketing campaigns to millions.
- Channels: push, email, SMS. Messages are built from templates with parameters and localized.
- Users choose per category and channel (e.g. "marketing: email only", "security: everything").
- Scheduling (`send_at`), quiet hours in the user's time zone, and frequency caps.
- Track sent / delivered / opened.

**Non-functional**

- **No losses:** an accepted notification is eventually attempted.
- **No duplicates** (or as close as we can get).
- Soft real-time: a passcode within seconds; a campaign within an hour.
- Survive provider outages and slowdowns.

## Step 2: Back-of-the-envelope estimates

Assume **100M users**, 40M push + 10M email + 1M SMS transactional per day, plus a weekly marketing blast to all 100M users that must finish within 1 hour.

```text
Transactional: 51M / 86,400 s           ≈ 590/s average, ~2,000/s at peak
Campaign:      100M / 3,600 s           ≈ 27,800/s for one hour  ← the real sizing driver

Worker concurrency (Little's Law, Day 52), provider call ≈ 100 ms:
               27,800/s × 0.1 s         ≈ 2,800 requests in flight

SMS cost:      1M/day × $0.008          = $8,000/day ≈ $2.9M/year
Email cost:    10M/day × $0.10 / 1,000  = $1,000/day
Log storage:   ~51M + campaigns ≈ 70M rows/day × 500 B ≈ 35 GB/day
```

Two lessons from the math: the **campaign burst**, not the daily average, sizes the system; and **SMS is expensive**, so a bug that sends SMS twice costs real money.

## Step 3: API

```text
POST /v1/notifications
Idempotency-Key: order-81723-shipped
{
  "userIds": ["u_42"],
  "category": "order_updates",           // drives preferences and priority
  "template": "order_shipped",
  "params": { "orderId": "81723", "eta": "Friday" },
  "channels": ["push", "email"],         // optional; default from category
  "sendAt": null                         // or an ISO time for scheduling
}
→ 202 Accepted { "notificationId": "n_9f2..." }

GET  /v1/notifications/{id}               status per channel
PUT  /v1/users/{id}/preferences           user settings
POST /v1/devices                          register a push token for a device
```

`202 Accepted` (Day 14) means "queued, not yet delivered". The caller never waits for Apple or Twilio.

## Step 4: Data model

```text
devices       (user_id, device_id, platform: ios|android|web, push_token, updated_at)
preferences   (user_id, category, channel, enabled)            + quiet_hours, timezone
templates     (template_id, locale, channel, subject, body)
notifications (notification_id, idempotency_key UNIQUE, user_id, category, status, created_at)
deliveries    (notification_id, channel, attempt, status, provider_msg_id, error, ts)
```

## Step 5: High-level design

```text
 order svc  security svc  campaign svc
      │          │             │  (bulk: segment → batches of 1,000 users)
      ▼          ▼             ▼
 ┌───────────────────────────────────┐
 │ Notification API                  │ validate, auth, idempotency check (Redis/DB)
 └───────────────┬───────────────────┘
                 ▼
        ┌──────────────────┐   high-priority topic   (OTP, security)
        │  Intake queues   │   normal topic          (transactional)
        └────────┬─────────┘   bulk topic            (marketing)
                 ▼
 ┌────────────────────────────────────┐   ┌─────────────────────────┐
 │ Router workers                     │──▶│ prefs, devices, templates│ (cached)
 │ prefs, quiet hours, freq caps,     │   └─────────────────────────┘
 │ render template, pick channels     │
 └──┬────────────┬──────────────┬─────┘
    ▼            ▼              ▼
 push queue   email queue    sms queue        ← one per channel, isolates failures
    ▼            ▼              ▼
 push workers email workers  sms workers ──▶ APNs / FCM / SES / Twilio
    │                                              │
    └── retry with backoff ── DLQ                  └─ webhooks: delivered, bounced, opened
                                                        ▼
                                                 tracking + analytics
```

## Step 6: Deep dives

### Why queues everywhere

Queues (Day 34) **absorb bursts** (27,800/s for an hour), **decouple** producers from slow providers, and **isolate failures**: if SMS is down, push and email keep flowing while SMS messages wait. Per-channel queues also let each worker pool respect its provider's rate limit.

### Retries and dead letters

Providers fail in two ways. **Transient** (timeouts, `429 Too Many Requests`, `5xx`): retry with exponential backoff and jitter (Day 43): 1 s, 2 s, 4 s … up to a limit, then move to a **dead-letter queue** for inspection. **Permanent** (APNs answers HTTP `410` for a token that's no longer valid; an email hard-bounces): don't retry. Delete the token or mark the address bad, or you'll keep paying for failures.

### Deduplication

Duplicates come from three places: the producer retries its API call, a worker crashes after sending but before acking its queue message (the queue redelivers), or the provider is retried after a timeout even though it actually sent.

- **Idempotency key at intake:** `SET key NX EX 86400` in Redis (or a unique DB index). A second request with the same key returns the original `notificationId`.
- **Per-delivery key before the provider call:** record "notification n_9f2, channel push, attempting" so a redelivered queue message can see it was already sent.
- Some risk remains: if the worker crashed between the provider call and writing "sent", you must choose. For an OTP, a duplicate is harmless; for marketing, prefer a rare miss over spam.

True exactly-once delivery to a phone is impossible (Day 43); you get at-least-once plus dedup.

### Preferences, quiet hours and frequency caps

The router checks, in order: is the category/channel enabled? Is it quiet hours in the user's time zone (then delay non-urgent messages)? Has the user hit their cap ("max 3 marketing pushes per day")? Here is that logic as a pure function:

```js
// Decide what to do with one notification for one user on one channel.
function decide(user, notif, sentToday, now) {
  if (notif.priority === "critical") return "send";               // OTP, security: always
  if (!user.prefs[`${notif.category}:${notif.channel}`]) return "drop";
  const hour = Number(new Intl.DateTimeFormat("en-US",
    { hour: "numeric", hourCycle: "h23", timeZone: user.timeZone }).format(now));
  const quiet = user.quiet.start > user.quiet.end
    ? hour >= user.quiet.start || hour < user.quiet.end            // wraps midnight, e.g. 22→7
    : hour >= user.quiet.start && hour < user.quiet.end;
  if (quiet) return "delay";
  if (notif.category === "marketing" && sentToday >= user.maxMarketingPerDay) return "drop";
  return "send";
}

const user = { timeZone: "Asia/Ho_Chi_Minh", quiet: { start: 22, end: 7 },
               maxMarketingPerDay: 3, prefs: { "marketing:push": true } };
const notif = { category: "marketing", channel: "push", priority: "normal" };
console.log(decide(user, notif, 1, new Date("2026-09-30T16:30:00Z"))); // 23:30 local → "delay"
console.log(decide(user, notif, 1, new Date("2026-09-30T03:00:00Z"))); // 10:00 local → "send"
```

### Priorities: OTPs must not wait behind a campaign

If a 100M-message campaign is queued and someone requests a login code, a single FIFO queue would make them wait an hour. Use **separate queues and worker pools per priority** (or strict priority consumption), reserve capacity for critical traffic, and rate-limit the bulk producer so it can't saturate shared providers.

### Reliable triggering: the outbox

"Order shipped" must be sent if and only if the order really shipped. If the order service updates its DB and then calls the notification API, a crash in between loses the notification. The **outbox pattern** (Day 44) writes the event into an outbox table in the same transaction as the order update; a relay publishes it afterwards, at least once, with a stable idempotency key like `order-81723-shipped`.

### Rate limits

Two kinds: **per user** (token bucket from Day 35, so a bug can't send someone 500 pushes), and **per provider** (your SMS account allows N messages/s; exceed it and you get `429`s). Workers pull from queues only as fast as their provider budget allows: that's backpressure.

## Step 7: Bottlenecks and trade-offs

- **Latency vs batching:** batching email calls is cheaper but delays individual messages; don't batch OTPs.
- **Dedup vs delivery:** when unsure whether a send happened, OTP leans "send again", marketing leans "skip".
- **Push token hygiene:** stale tokens waste capacity; clean them up from provider feedback.
- **Multi-provider failover** for SMS/email improves availability but complicates dedup and tracking.

## In an interview

Interviewers want: an async API that returns 202, queues per channel and priority, preference and quiet-hour checks, retries with backoff and a DLQ, idempotency keys, rate limits, and burst math. Model summary:

> "Producers call an API that validates, dedups on an idempotency key and enqueues, returning 202. Router workers apply preferences, quiet hours, frequency caps and templates, then enqueue per-channel jobs on separate priority lanes so OTPs never wait behind a campaign. Channel workers call APNs, FCM, SES and Twilio within provider rate limits, retry transient failures with jittered backoff, dead-letter the rest, and remove invalid tokens. Delivery is at-least-once with dedup; a 100M campaign in an hour means ~28k sends/s and ~2,800 in-flight calls."

## Common mistakes

- **Calling providers synchronously from the API.** One slow provider then stalls every producer.
- **One queue for everything.** Marketing blasts delay passcodes; one channel's outage blocks the others.
- **Retrying permanent errors.** A `410` token or a hard bounce will never succeed.
- **Ignoring time zones.** "Quiet hours 22:00–07:00" means the user's 22:00.
- **Promising exactly-once delivery.** Say at-least-once plus idempotency.

## Before moving on

- [ ] I can draw the pipeline: API → queue → router → channel queues → providers
- [ ] I can explain where duplicates come from and three ways to prevent them
- [ ] I can size the system from a campaign burst using Little's Law
- [ ] I can explain priority lanes and per-provider rate limits
- [ ] I can explain why the outbox pattern helps "send exactly when X happened"

## Go deeper (optional)

- [Push technology on Wikipedia](https://en.wikipedia.org/wiki/Push_technology)
- [Apple Push Notification service documentation](https://developer.apple.com/documentation/usernotifications)
- [Firebase Cloud Messaging documentation](https://firebase.google.com/docs/cloud-messaging)
- *System Design Interview* by Alex Xu, Volume 1, chapter on notification systems
