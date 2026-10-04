# Transactions and Isolation

> Two people click "buy" on the last concert ticket at the same millisecond. A server crashes halfway through moving money between accounts. Transactions are how databases keep these situations from turning into lost money and angry customers, and isolation levels are the fine print every backend engineer should be able to read.

## The big idea

A **transaction** is a group of reads and writes the database treats as **one unit**: either all of it happens, or none of it does, and other users don't see the half-done middle.

Think of a bank transfer of $100 from Ana to Bo:

```sql
BEGIN;
UPDATE accounts SET balance = balance - 100 WHERE id = 'ana';
UPDATE accounts SET balance = balance + 100 WHERE id = 'bo';
COMMIT;
```

If the power fails between the two `UPDATE`s, $100 must not vanish. If someone runs a report mid-transfer, they shouldn't see the money "in flight". `COMMIT` makes it permanent; `ROLLBACK` (or a crash before commit) undoes everything.

## ACID, one letter at a time

| Letter | Means | Plain words | How the DB does it |
|---|---|---|---|
| **A**tomicity | all or nothing | a crash or error mid-way undoes the partial work | write-ahead log + undo |
| **C**onsistency | invariants hold | "balances never negative", foreign keys valid | constraints + *your* app logic |
| **I**solation | concurrent transactions don't trip over each other | as if they ran one at a time (to some degree) | locks, MVCC |
| **D**urability | committed means saved | survives crashes and power loss | WAL flushed with `fsync` (Day 8), replicas |

Note the "C" is partly your job: the database only enforces the rules you told it about.

## The write-ahead log (WAL)

How can a database promise atomicity and durability when a crash can happen at any instant? It follows one rule: **write what you're about to do to a log, and flush the log to disk, before calling the transaction committed.**

```text
1. BEGIN
2. append to WAL: "txn 81: ana.balance 500 -> 400"
3. append to WAL: "txn 81: bo.balance 200 -> 300"
4. append to WAL: "txn 81 COMMIT"   + fsync   <-- the moment of truth
5. tell the client "committed"
6. later, lazily: write the changed data pages to the table files
```

After a crash, the database **replays** the WAL: transactions with a COMMIT record are redone; anything without one is ignored or undone. Appending to a log is sequential and fast (Day 19), so this is cheap. The same WAL is also what gets shipped to replicas (Day 31).

## Isolation: what goes wrong without it

If transactions ran one at a time (**serially**), nothing would go wrong, but databases run thousands at once. These are the classic **anomalies**. Learn their names; interviewers use them.

**Dirty read**: you read data another transaction wrote but hasn't committed (and might roll back).

```text
T1: UPDATE balance = 0 (not committed)
T2:                          SELECT balance -> 0   (dirty!)
T1: ROLLBACK                 T2 acted on a value that never existed
```

**Non-repeatable read** (read skew): you read the same thing twice in one transaction and get different answers, because someone committed in between. A backup or report sees Ana's account *before* a transfer and Bo's *after*, and $100 disappears from the totals.

**Lost update**: two transactions read-modify-write the same value; one overwrites the other.

```text
counter = 10
T1: SELECT counter -> 10
T2: SELECT counter -> 10
T1: UPDATE counter = 11; COMMIT
T2: UPDATE counter = 11; COMMIT     -> should be 12. One like vanished.
```

**Phantom**: a query's *set of matching rows* changes. "Are there any bookings for room 5 at 3 pm?" returns none, but another transaction inserts one right after.

**Write skew**: two transactions read the same data, each makes a decision that's fine alone, and they write *different* rows. Together they break a rule.

```text
Rule: at least one doctor must be on call. Alice and Bob are both on call.
T1 (Alice): SELECT count(*) on call -> 2.  OK to leave. UPDATE alice off_call.
T2 (Bob):   SELECT count(*) on call -> 2.  OK to leave. UPDATE bob   off_call.
Both commit -> zero doctors on call.
```

No row was written twice, so row locks on what's written don't catch it. That's what makes write skew sneaky.

## Isolation levels

The SQL standard defines four levels. Stronger means fewer anomalies but more waiting or more aborted transactions.

| Level | Dirty read | Non-repeatable read | Phantom | Lost update | Write skew |
|---|---|---|---|---|---|
| Read uncommitted | possible | possible | possible | possible | possible |
| Read committed | prevented | possible | possible | possible | possible |
| Repeatable read / snapshot | prevented | prevented | depends on DB | depends on DB | possible |
| Serializable | prevented | prevented | prevented | prevented | prevented |

Real-world defaults matter more than the standard:

- **PostgreSQL**: default **Read Committed**. Its Repeatable Read is **snapshot isolation**: it aborts one of two transactions updating the same row (stopping lost updates) but still allows write skew. Its Serializable uses **SSI** (serializable snapshot isolation) and aborts transactions that could form a non-serial pattern.
- **MySQL InnoDB**: default **Repeatable Read**. Plain `SELECT`s read a snapshot, but `UPDATE` sees the latest data, so a read-then-write lost update can still happen.
- Oracle and SQL Server: default Read Committed.

So "we use transactions" doesn't mean "we're safe". At the default level of most databases, lost updates and write skew are possible.

## MVCC: how readers don't block writers

**Multi-version concurrency control** keeps **several versions** of each row instead of overwriting it. Each transaction reads from a **snapshot**: the versions committed when its snapshot was taken.

```text
row "ana" versions:
  balance=500   created by txn 70, deleted by txn 81
  balance=400   created by txn 81

txn 80 (snapshot taken before 81 committed) reads 500
txn 90 (after) reads 400
```

PostgreSQL stores this in hidden columns (`xmin`, `xmax`: the creating and deleting transaction IDs). Readers never wait for writers and writers never wait for readers. The cost: old versions pile up and must be cleaned (PostgreSQL's `VACUUM`). Under Read Committed each *statement* gets a fresh snapshot; under Repeatable Read the whole *transaction* uses one.

## Locking and the fixes you'll actually use

When you need to stop lost updates and write skew, you have four tools:

**1. Atomic updates.** Let the database do the read-modify-write in one step.

```sql
UPDATE posts SET likes = likes + 1 WHERE id = 7;      -- safe
```

**2. Explicit row locks** (pessimistic): lock the rows you read so nobody else can change them until you commit.

```sql
BEGIN;
SELECT * FROM seats WHERE id = 'A12' FOR UPDATE;       -- others wait here
-- check it's free, then
UPDATE seats SET owner = 'kim' WHERE id = 'A12';
COMMIT;
```

**3. Optimistic concurrency** with a version column: don't lock, but detect a conflict at write time.

```sql
UPDATE docs SET body = $1, version = version + 1
WHERE id = 9 AND version = 4;     -- 0 rows updated? someone beat you: reload and retry
```

**4. Serializable isolation**: let the DB detect conflicts and abort; your code must **retry** aborted transactions.

Locks have a classic risk: **deadlock** (Day 7). T1 locks row A then wants B; T2 locks B then wants A. Databases detect the cycle and abort one. Locking rows in a consistent order (e.g. by id) avoids it.

## Lost update in JavaScript

You can feel the race without a database:

```js
let balance = 100;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function withdraw(amount) {
  const current = balance;          // read
  await sleep(10);                  // e.g. a network call to the DB
  balance = current - amount;       // write based on stale read
}

await Promise.all([withdraw(30), withdraw(50)]);
console.log(balance);               // 50, not 20! The $30 withdrawal was lost.
```

Both read 100 before either wrote. The fix is the same as in SQL: make the read-modify-write one atomic step, or detect the conflict.

## The math: why lost updates matter at scale

```text
A post gets 1,000 likes/second, using read-then-write in the app.
Each read-modify-write takes 5 ms between read and write.
Average other likes arriving during that window: 1,000 × 0.005 = 5
```

So nearly every like overlaps with ~5 others, and the counter ends up drastically under-counted. `likes = likes + 1` (one atomic statement) costs the same and is correct.

## In an interview

Expect: "what does ACID mean?", "what isolation level does Postgres use by default?", "two users book the same seat, what happens?", "how do you avoid double spending?" Strong answers name the specific anomaly and pick a specific fix.

> "Atomicity and durability come from the write-ahead log: changes are appended and fsynced before commit and replayed after a crash. Isolation is a spectrum. Most databases default to read committed, which still allows lost updates and write skew. For a counter I'd use an atomic `UPDATE ... SET x = x + 1`; for booking a seat I'd use `SELECT ... FOR UPDATE` or a unique constraint; for complex invariants like 'at least one doctor on call' I'd use serializable isolation and retry on serialization failures."

## Common mistakes

- **"Wrapping it in a transaction makes it safe."** Not at read committed: read-then-write races still happen.
- **Read-modify-write in application code** instead of an atomic `UPDATE`.
- **Not retrying** serialization failures or deadlock aborts. At strict levels, aborts are normal.
- **Long transactions** holding locks while calling external APIs. Keep transactions short.
- **Confusing ACID's C with CAP's C** (Day 39). Different meanings entirely.

## Before moving on

- [ ] I can explain each ACID letter with an example
- [ ] I can explain how a WAL gives atomicity and durability after a crash
- [ ] I can describe dirty read, non-repeatable read, lost update, phantom and write skew
- [ ] I know the default isolation level of PostgreSQL and MySQL
- [ ] I can fix a lost update three ways (atomic update, `FOR UPDATE`, version check)
- [ ] I can explain MVCC in two sentences

## Go deeper (optional)

- *Designing Data-Intensive Applications*, chapter 7 "Transactions"
- [PostgreSQL docs: Transaction Isolation](https://www.postgresql.org/docs/current/transaction-iso.html)
- [Wikipedia: ACID](https://en.wikipedia.org/wiki/ACID)
- [Wikipedia: Multiversion concurrency control](https://en.wikipedia.org/wiki/Multiversion_concurrency_control)
