# CI/CD and Safe Deploys

> Most outages are not caused by hardware or hackers. They are caused by *us*, shipping a change. Today is about the machinery that lets a team ship dozens of times a day without breaking things: automated pipelines, gradual rollouts, and fast undo buttons.

## The big idea

Think of a restaurant kitchen. Before any dish leaves, it passes the **pass**: the head chef tastes it, checks the plate, and only then does a waiter carry it out. And when the kitchen adds a new dish to the menu, a smart restaurant doesn't put it on every table at once. It offers it as a "special" to a few tables first and watches their faces.

Software teams do the same two things:

1. **Continuous Integration (CI):** every change is automatically built and tested the moment it is pushed, so bad code is caught at "the pass", before it reaches anyone.
2. **Continuous Delivery / Deployment (CD):** changes that pass are packaged and rolled out to production *gradually*, with the ability to undo quickly.

Three terms people mix up:

| Term | Meaning |
|---|---|
| Continuous Integration | Everyone merges small changes into the main branch often (at least daily); each merge is built and tested automatically |
| Continuous Delivery | Every change that passes CI is *ready* to release; a human presses the button |
| Continuous Deployment | Every change that passes CI goes to production automatically, no button |

## How a CI pipeline works

A **pipeline** is a list of automated steps that runs on a CI server (GitHub Actions, GitLab CI, Jenkins, CircleCI...) whenever code is pushed. It runs in a fresh, clean machine or container (remember Day 49) so "it works on my laptop" can't hide problems.

```text
 git push
    │
    ▼
┌─────────┐  ┌──────────┐  ┌───────┐  ┌─────────────┐  ┌──────────┐
│ install │→ │ lint +   │→ │ unit  │→ │ build image │→ │ integr.  │→ artifact
│  deps   │  │ typecheck│  │ tests │  │  (Docker)   │  │ tests    │   stored
└─────────┘  └──────────┘  └───────┘  └─────────────┘  └──────────┘
   fails fast: cheap checks first, slow checks last
```

Key ideas:

- **Fail fast.** Run the cheapest checks first. A lint error should fail in 20 seconds, not after a 15-minute test suite.
- **Build once, deploy many.** The pipeline produces one **artifact** (a Docker image tagged with the commit hash, e.g. `api:3f9a2c1`). The *same* artifact goes to staging and then production. Never rebuild for production, or you are shipping something you didn't test.
- **Pull request checks.** The pipeline runs on every pull request, and the merge button stays disabled until it passes.

A minimal GitHub Actions file looks like this (YAML, shown for flavor):

```text
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm run lint
      - run: npm test
```

### The test pyramid

```text
          /\        end-to-end (browser clicks)   few, slow, flaky
         /  \
        /----\      integration (real DB, real HTTP)  some
       /      \
      /--------\    unit (one function)            many, fast, reliable
```

Unit tests run in milliseconds and pinpoint the bug. End-to-end tests catch "the pieces don't fit" bugs but are slow and **flaky** (they sometimes fail for no real reason: timing, network). A healthy suite is mostly unit tests.

## Deploy strategies

Passing tests does not mean the change is safe. Production has real traffic, real data and real weirdness. So we **limit the blast radius**: the number of users who can be hurt if the change is bad.

### Rolling deploy

Replace servers a few at a time. With 10 servers: take 2 out, update them, put them back, repeat. This is Kubernetes' default (`maxSurge`, `maxUnavailable` from Day 49).

- Pro: no extra servers needed.
- Con: for a while, old and new versions run **side by side**, so they must be compatible. Rollback is another rolling deploy (slow-ish).

### Blue-green deploy

Run two full environments. **Blue** serves traffic; you deploy to **green**, test it, then flip the load balancer (Day 28) to green in one step.

```text
            ┌──────────── blue (v1)  ← traffic today
 users → LB ┤
            └──────────── green (v2) ← deploy + smoke test, then flip
```

- Pro: instant switch, instant rollback (flip back).
- Con: double the servers during the deploy; all users move at once.

### Canary deploy

Named after the canaries miners carried: if the bird got sick, there was gas. Send a small slice of traffic to the new version and compare its health to the old one.

```text
step 1:   1% → v2   watch 10 min: error rate, p99 latency (Day 46)
step 2:  10% → v2   watch 10 min
step 3:  50% → v2   watch
step 4: 100% → v2   done
any step looks worse than v1?  →  send 0% to v2 (automatic rollback)
```

- Pro: a bad change only hurts 1% of users, for minutes.
- Con: more tooling; you need good metrics to judge "worse".

| Strategy | Extra capacity | Rollback speed | Blast radius | Mixed versions? |
|---|---|---|---|---|
| Rolling | little | minutes | grows step by step | yes |
| Blue-green | 2x | seconds | everyone at once | no |
| Canary | small | seconds | tiny at first | yes |

## Feature flags: decouple deploy from release

A **feature flag** is an `if` statement whose condition lives in a config service you can change at runtime, without deploying. Code ships "dark" (turned off), and you **release** it later by flipping the flag, maybe for 5% of users first.

```js
const crypto = require("crypto");

// Same user always lands in the same bucket (0..99), so their experience is stable.
function bucket(userId, flagName) {
  const h = crypto.createHash("sha256").update(flagName + ":" + userId).digest();
  return h.readUInt32BE(0) % 100;
}

function isEnabled(flag, userId) {
  if (!flag.on) return false;               // global kill switch
  if (flag.allowList.includes(userId)) return true;
  return bucket(userId, flag.name) < flag.percent;
}

const newCheckout = { name: "new-checkout", on: true, percent: 5, allowList: ["alice"] };
console.log(isEnabled(newCheckout, "alice")); // true
console.log(isEnabled(newCheckout, "u_123")); // true for ~5% of user ids
```

Hashing (Day 25) makes the rollout *sticky*: a user doesn't flip between old and new on every page load. Including the flag name in the hash means the same 5% of users don't get every experiment.

Flags are powerful but they are debt: every flag doubles the code paths. Remove them once a feature is fully launched.

## Rollbacks and the database problem

Rolling back code is easy: redeploy the previous image. Rolling back **data** is not. If v2 dropped a column, v1 can't come back.

The fix is the **expand / contract** pattern (also called "parallel change"). Example: rename `name` to `full_name`.

```text
1. Expand:   add column full_name (nullable). Old code ignores it.     deploy
2. Dual-write: new code writes both name and full_name.               deploy
3. Backfill: copy name → full_name for old rows, in small batches.
4. Switch reads: code reads full_name.                                deploy
5. Contract: stop writing name, later drop the column.                deploy
```

At every step, the **current and previous** code versions both work with the schema, so any single deploy can be rolled back. Rules of thumb:

- Never make a schema change and the code that depends on it in the same deploy.
- Adding is safe; removing and renaming are dangerous.
- Big backfills run in batches (say 1,000 rows at a time) so they don't lock tables (Day 22).

## The math

**Flaky tests add up.** Say you have 200 end-to-end tests, each with a 0.5% chance of failing randomly. Probability a run is all green:

```text
P(all pass) = 0.995^200 = e^(200 · ln 0.995) ≈ e^(-1.0025) ≈ 0.367
```

Only about **37%** of pipeline runs pass even when the code is perfect. That's why teams quarantine flaky tests: tiny per-test flakiness becomes huge at suite level.

**Canary blast radius.** Your service gets 2,000 requests/second. A bad build fails 30% of requests. Your canary at 1% runs 10 minutes before auto-rollback:

```text
requests to canary = 2,000 × 0.01 × 600 s = 12,000
failed             = 12,000 × 0.30          = 3,600 errors
same bug, 100% deploy, 10 min = 2,000 × 600 × 0.30 = 360,000 errors
```

A 100x smaller blast radius for the same mistake.

**DORA metrics.** Google's DevOps Research and Assessment (DORA) program found four numbers that separate strong teams: **deployment frequency**, **lead time for changes** (commit to production), **change failure rate**, and **time to restore service**. Good teams deploy small changes often; small changes are easier to test, review and roll back.

## In an interview

CI/CD shows up in two ways: directly ("how would you deploy this safely?") and at the end of any design ("how do you roll this out?"). Interviewers listen for *blast radius* thinking, automatic rollback based on metrics, and awareness that the database is the hard part.

A strong answer: "Every PR runs lint, unit and integration tests in CI and produces one immutable image tagged by commit. We deploy that image to staging, then canary it in production at 1%, 10%, 50%, 100%, with automated checks comparing error rate and p99 latency against the baseline; a regression triggers automatic rollback. Risky features ship behind flags so release is separate from deploy. Schema changes follow expand/contract, so every deploy is backward compatible and safely reversible."

## Common mistakes

- **"Tests passed, so it's safe."** Tests check what you thought of. Canaries check what you didn't.
- **Rebuilding the artifact per environment.** Build once; promote the same image.
- **Big-bang releases.** A month of changes in one deploy makes it impossible to tell which change broke things.
- **Destructive migrations shipped with code.** Drop columns only after nothing reads them, in a later deploy.
- **Never-deleted flags.** Old flags turn code into a maze; give each one an owner and an expiry.

## Before moving on

- [ ] I can explain CI vs continuous delivery vs continuous deployment
- [ ] I can compare rolling, blue-green and canary on cost, speed and blast radius
- [ ] I can explain how a feature flag gives a sticky percentage rollout
- [ ] I can walk through expand/contract for a column rename
- [ ] I can compute how flaky tests compound across a suite

## Go deeper (optional)

- [Continuous integration (Wikipedia)](https://en.wikipedia.org/wiki/Continuous_integration)
- [Feature toggle (Wikipedia)](https://en.wikipedia.org/wiki/Feature_toggle)
- *Accelerate* by Forsgren, Humble and Kim (the research behind DORA metrics)
- *Continuous Delivery* by Jez Humble and David Farley
