# industry.md — Phase 5: Points + PointsLedger + Upgrade-Only ProblemProgress

How real-world systems solve the same problems this phase solved, and how
this project's approach compares. See `decisions.md` for why each choice was
made and `explain_points.md` for how the mechanisms actually work — this
file adds the external comparison only.

---

### 1. Scoring formula as a pure function, isolated from infrastructure

**The problem**: a system whose core value depends on a formula (a score, a
price, a ranking weight) needs that formula to be correct and easy to
verify independently of everything else the system does — the database, the
web layer, the surrounding orchestration.

**How this project does it**: `PointsCalculator` is a final class of static
methods (`basePoints`, `starsMultiplier`, `speedFactor`, `totalPoints`) with
no Spring annotation, no injected dependency, nothing but arithmetic —
tested in isolation with 8 cases covering every star tier and both
speed-factor extremes, in under half a second with no database or Spring
context involved. See `decisions.md` #1 and the formula walkthrough in
`explain_points.md`.

**Industry approaches**: isolating pure calculation from side-effecting
infrastructure is a widely-taught general pattern — Gary Bernhardt's
"Boundaries" talk popularized the "functional core, imperative shell" name
for exactly this shape, and it's the same reasoning generally cited for
keeping pricing engines, tax calculators, and game-scoring logic as pure
functions: a deterministic function of primitive inputs can be unit
tested exhaustively, in isolation, without standing up a database or a
live service call. Game and gamification scoring systems generally
converge on the same
approach — a scoring function that takes primitive inputs (accuracy, time,
difficulty) and returns a number, callable identically from a live request
handler, a batch recalculation job, or a test.

**Why this project differs (or doesn't)**: it doesn't differ — this is the
standard shape for this exact kind of logic, applied for the standard
reason. `decisions.md` #1 states it directly: isolating the formula means a
failure in the arithmetic and a failure in the locking/transaction logic
point at different files, not one tangled test.

**Trade-offs**:
- Gives up: nothing structural — a pure function has no real downside here;
  if anything it's less code than embedding the same math inline in a
  `@Service`.
- Gains: sub-second, infrastructure-free tests for the one piece of logic
  most likely to need tuning (`decisions.md` #1 names the `SWING` constant
  and star-tier multipliers as the expected future edit point), and a
  formula that's trivially reusable if it's ever needed outside the request
  path (a batch recompute, an admin preview tool).
- Worth revisiting if: never, really — this pattern scales down to zero
  cost and up to any system size; there's no point at which embedding the
  math back into a stateful service becomes the better choice.

### 2. Preventing lost updates on concurrent read-modify-write

**The problem**: two concurrent operations reading the same row, each
computing a new value from what they read, and writing it back, can lose
one of the two updates entirely — whichever writes second overwrites the
first without ever seeing it. A system with any concurrent write path onto
the same record needs a real mechanism to prevent this, not just to make it
rare.

**How this project does it**: two repository methods, always run together —
`ensureRowExists` (`INSERT ... ON CONFLICT (user_id, scenario_id) DO
NOTHING`, race-safe even for two simultaneous *first* solves) followed by
`lockByUserIdAndScenarioId` (`@Lock(PESSIMISTIC_WRITE)`, Postgres `SELECT
... FOR UPDATE`), which blocks a concurrent submit for the same
(user, scenario) until the first transaction commits. This runs
unconditionally on every qualifying submit, not just ones detected as
contested. See `decisions.md` #2 and the "why locking happens on every
submit" section of `explain_points.md`.

**Industry approaches**: pessimistic row locking (`SELECT ... FOR UPDATE`)
is one of two standard relational patterns for this problem, and is the one
most commonly reached for when the contended window is short and the
correct behavior on conflict is "wait," not "reject" — it's the same
mechanism behind, e.g., decrementing inventory count or account balance
rows in most SQL-backed order/payment systems. The other standard pattern,
**optimistic concurrency control** (a `version` column checked on `UPDATE
... WHERE version = ?`, incremented on success, retried on mismatch — the
default behavior of JPA's own `@Version`/`@OptimisticLocking`), avoids
holding a lock across the whole read-modify-write window at the cost of
needing an application-level retry loop when a conflict is actually
detected. At even higher write volume, some leaderboard-shaped systems skip
row locking entirely in favor of an atomically-conditional single
statement — Redis's `ZADD GT` (only update a sorted-set member's score if
the new value is greater) is a well-known example of pushing the
"upgrade-only" comparison itself into one atomic server-side operation
rather than a separate lock-then-compare-then-write round trip.

**Why this project differs (or doesn't)**: pessimistic locking over
optimistic concurrency is a deliberate choice for this exact "upgrade-only
best score" shape, though the underlying reasoning is really about keeping
the business logic ("was this an improvement, what's the delta, does a
ledger entry get written") in readable Java rather than a database
expression — `decisions.md` #2 explicitly considered a single
`GREATEST()`/`CASE`-embedded upsert (closer to the Redis `ZADD GT` idea)
and rejected it for that reason, not because it wouldn't work.

**Trade-offs**:
- Gives up: throughput under real contention — a pessimistic lock makes a
  second concurrent submitter for the same (user, scenario) wait for the
  first transaction to finish rather than proceeding independently and
  only retrying on conflict (what optimistic locking would do), and it's a
  strictly more expensive per-request cost than a single conditional SQL
  statement with no application-side lock at all.
- Gains: the actual business logic (compute the delta, decide whether to
  write a ledger entry) stays in plain, readable, unit-testable Java rather
  than a SQL expression, and correctness doesn't depend on getting a retry
  loop right.
- Worth revisiting if: the same (user, scenario) pair sees enough genuine
  concurrent submit volume that lock contention itself becomes a measurable
  bottleneck — nothing close to that exists in a single-instance app with
  no realistic traffic where the same user submits the same scenario twice
  in the same instant except in a deliberately constructed test.

### 3. Append-only ledger for auditability

**The problem**: a system that awards value over time (points, credits,
balance changes) benefits from a durable, immutable record of *every*
individual award — not just the current total — so a total can be
explained, disputed, or reconstructed independently of the mutable
"current state" row.

**How this project does it**: every time a submit actually improves a
user's best result for a scenario, a `PointsLedgerEntry` is inserted
(`deltaPoints`, `runningTotalForScenario`) alongside the upgrade to
`ProblemProgress`'s best-result columns — the ledger is written to, never
updated or deleted. See the README's description of `PointsLedger` and
step 7 of the recording flow in `explain_points.md`.

**Industry approaches**: an append-only ledger recording every individual
change, with the current balance being a derived/cached value rather than
the sole source of truth, is exactly the model double-entry bookkeeping and
every real financial ledger use — and it's explicitly how Stripe's public
API models balance changes: every `Balance Transaction` object is an
immutable record of one change, and an account's current balance is
computable from (and verifiable against) the sum of its transactions.
Event sourcing generalizes the same idea to arbitrary application state
(the log of events *is* the source of truth, current state is a projection
of it), and audit-log tables in most enterprise systems (who-changed-what-
when, kept forever, never mutated) follow the identical append-only
principle for compliance/dispute-resolution reasons.

**Why this project differs (or doesn't)**: it doesn't differ — this is the
same append-only pattern used for the same reason (an explainable,
reconstructable history of every award), scoped down to only the one moving
part (points) that actually needs it, rather than generalized to every
piece of state the way full event sourcing would.

**Trade-offs**:
- Gives up: nothing versus the pattern itself at this scale — the ledger
  table is small (one row per genuine improvement, not per attempt) and
  costs one extra insert inside a transaction that's already open.
- Gains: `ProblemProgress`'s current best-result columns stay fast to read
  (`GET /progress/scenarios/{id}` never has to sum a ledger to answer "what's
  my best score"), while the ledger still exists for anything that later
  needs the full history rather than just the current total.
- Worth revisiting if: a feature needs to show a user's full points-earning
  timeline, or a dispute/audit ever needs to recompute a total from
  scratch — the ledger already has everything that would need, without any
  schema change.

### 4. Coupling a side effect to its trigger inside one transaction (vs. saga/outbox patterns)

**The problem**: a system where one action (an attempt being finalized)
must have a consequence (points awarded, progress updated) needs those two
things to either both happen or neither happen — a state where one occurred
without the other is a real data integrity bug, not a cosmetic one.

**How this project does it**: `AttemptFinalizer.finalizeVerified` calls
`problemProgressService.recordOutcome(...)` as its last step, inside the
same `@Transactional` method that marks the attempt SUBMITTED — a normal
cross-bean call, not a separate subsequent step, so both commit or roll
back together automatically via one Postgres transaction. See
`decisions.md` #4.

**Industry approaches**: wrapping a trigger and its consequence in one
ACID database transaction is the simplest possible version of this problem,
and it's exactly how most single-database, single-service applications
handle it — it only stops being an option once the trigger and its
consequence live in *different* services or data stores, which is where the
**outbox pattern** (write the "points should be awarded" fact into an
outbox table in the same transaction as the primary write, then a separate
process reliably publishes it to whatever awards points elsewhere) and the
**saga pattern** (a sequence of local transactions across services, each
with a defined compensating action if a later step fails) come from —
both are standard, widely-documented answers (Chris Richardson's
microservices.io patterns catalog is the commonly-cited reference for both)
to "how do you get transactional-like guarantees when one database
transaction can't span the whole operation."

**Why this project differs (or doesn't)**: it doesn't need the outbox/saga
machinery because there's no service boundary here to cross — points,
progress, and the attempt all live in the same Postgres database behind the
same Spring service, so one `@Transactional` method is a complete, correct
answer. This is the honest reason, not a simplification of a harder problem
this project actually has: the outbox/saga patterns solve a problem
(cross-service consistency) that doesn't exist in a single-database
monolith.

**Trade-offs**:
- Gives up: nothing at this architecture — there's no distributed-
  consistency problem being under-solved, because there's no distribution.
- Gains: a strictly simpler, more obviously correct guarantee (one ACID
  transaction) than any message-based eventual-consistency pattern would
  provide, with no risk of an outbox message being delayed, duplicated, or
  needing idempotent-consumer handling on the other end.
- Worth revisiting if: points/progress or attempt-finalization ever moves
  to a separate service or datastore from the other (a genuine
  microservices split) — that's the exact point this simple approach stops
  being available and an outbox or saga becomes necessary, not optional.

### 5. Proving a concurrency guarantee deterministically, not by timing luck

**The problem**: testing that a lock/mutex/isolation mechanism actually
prevents a race is harder than testing ordinary logic — a test that merely
starts two threads "at the same time" and checks the end result can pass
even when the protection mechanism is completely absent, if the two
threads' real work never happened to overlap.

**How this project does it**: `ProblemProgressConcurrencyTest` includes a
test that directly proves the blocking mechanism itself
(`pessimisticLockActuallyBlocksAConcurrentReader`) — one thread holds the
lock open for a fixed 400ms via a `CountDownLatch`, and a second thread's
attempt to acquire the same lock is timed and must take at least ~350ms.
This was added after discovering the more natural end-to-end race test
(`twoSimultaneousSubmitsNeverDoubleAwardPoints`) still passed 3 times in a
row with the lock entirely removed — a `CyclicBarrier`-synchronized start
guarantees threads *begin* together, not that their actual reads/writes
land close enough to race. See `decisions.md` #3 in full.

**Industry approaches**: this exact failure mode — a concurrency test that
passes for the wrong reason because the race window never actually got hit
— is well known in distributed-systems and concurrency testing circles.
Jepsen (Kyle Kingsbury's widely-cited distributed-systems testing
framework) is built entirely around the principle that you cannot trust a
system's concurrency claims from its code or from hopeful end-to-end
testing — you have to actively construct and verify the failure mode
happening, with fault injection and history-checking, not just run
"realistic" traffic and hope. At a smaller scale, dedicated concurrency-
testing tools exist for the exact same reason — Java's JCStress
(OpenJDK's own concurrency stress-testing harness) exists specifically
because ordinary unit tests are bad at reliably reproducing race windows,
and deliberately uses controlled thread coordination (barriers, forced
interleavings) rather than "start two threads and hope" for the same reason
this project's second test does.

**Why this project differs (or doesn't)**: it doesn't differ from that
industry lesson — this phase independently rediscovered the same failure
mode Jepsen/JCStress exist to address (an end-to-end race test can pass
with zero real protection) and applied the same fix those tools formalize:
test the mechanism directly and deterministically, verified in both
directions (fails without the lock, passes with it), rather than trusting a
best-effort race to manifest.

**Trade-offs**:
- Gives up: nothing — this is strictly better testing practice than relying
  on the end-to-end race test alone, for the same amount of code (one
  additional, deterministic test).
- Gains: a concurrency guarantee that's actually proven, not merely
  plausible — the kind of gap (a passing test that would still pass with
  the bug present) that's genuinely dangerous because it looks like
  coverage.
- Worth revisiting if: this project ever needs a *distributed* lock (across
  multiple app instances, not just multiple threads against one Postgres
  instance) — at that point a full Jepsen-style fault-injection suite would
  be the appropriate next step up, since a single-process deterministic
  test like this one can't exercise network partitions or instance
  failures.

---

## Summary

For a single-instance app backed by one Postgres database, this phase's
choices are the correct ones, not scaled-down compromises: a pure scoring
function, pessimistic row locking for a short-lived contended write, an
append-only ledger, one ACID transaction covering trigger-plus-consequence,
and a deterministic proof of the locking mechanism are each either the
direct industry-standard answer to the same problem or a deliberately
simpler variant justified by the absence of a problem (no cross-service
boundary, so no outbox/saga; no real lock contention, so no need to
optimize past pessimistic locking) that a distributed or high-traffic
system would actually have. The one place scale would force a real change
is mechanism #4 — the single-transaction guarantee stops being available
the moment points/progress and attempt-finalization are ever split across
services, and that's a genuine architectural cliff worth remembering, not
a gap in the current implementation.
