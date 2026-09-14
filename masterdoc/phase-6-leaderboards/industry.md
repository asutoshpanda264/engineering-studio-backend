# industry.md — Phase 6: how real systems solve the same problems

How the mechanisms this phase built compare to publicly documented
industry approaches to the same underlying problems. For what was
actually built and why, see `decisions.md` and `explain_leaderboard.md`
in this folder — this file adds no new claims about this project, only
restates and compares.

---

### 1. Leaderboard storage and update strategy: recompute-and-overwrite vs. incremental

**The problem**: a leaderboard needs a data structure that supports
fast top-N and rank-of-user reads, and a decision about how a score
changes when the underlying data changes — apply a small delta at
write time, or recompute the value fresh from the source of truth.

**How this project does it**: three Redis ZSETs, one write pattern
across all of them — on every `ProblemProgressUpgradedEvent`,
`refreshUser` re-reads that one user's current aggregate stats fresh
from Postgres and `ZADD`s (overwrites) their membership in all three
boards. No `ZINCRBY` anywhere in the package. `POST
/admin/leaderboard/rebuild` replays this for every eligible user,
proving Redis can be wiped and fully regenerated at any time. See
`decisions.md` #1.

**Industry approaches**: Redis's own documentation and Redis
University materials describe sorted sets as *the* canonical data
structure for real-time gaming and social leaderboards, and their
worked examples typically use `ZINCRBY` to bump a score by a delta at
the moment each scoring event happens — appropriate when score-changing
events happen at a rate (thousands per second in a live game) where
re-aggregating from a system of record on every event isn't
affordable. On the recompute side, the same "full rebuild from source"
vs. "incremental update" choice is a long-standing, named trade-off in
data-warehouse tooling: dbt offers both a `table` materialization
(rebuild the whole thing from source on every run) and an `incremental`
one (append/merge only new rows since last run) — and even
`incremental` models keep a `--full-refresh` escape hatch specifically
because incremental logic can silently drift from what a from-scratch
rebuild would produce. Teams commonly stay on plain `table` for a model
until its rebuild cost genuinely forces a move to `incremental`, which
is close to this project's own trajectory in miniature.

**Why this project differs (or doesn't)**: this project chose the
recompute side for the same reason dbt users cite for staying on
`full-refresh` — correctness with less to get wrong. `decisions.md` #1
states it plainly: an incremental approach requires every increment
to have actually applied exactly once, in order, or Redis drifts from
Postgres permanently with no way to detect it short of recomputing
everything anyway; recompute-and-overwrite is naturally idempotent
because it's always derived from what Postgres says *right now*. The
`ZINCRBY` approach industry gaming leaderboards use exists to solve a
volume problem this project doesn't have — `decisions.md` #1 names the
cost explicitly as "irrelevant at this project's scale (one row read
per user event, not per request)."

**Trade-offs**:
- Gives up: the ability to handle a high-frequency write volume
  without each write paying for a fresh aggregate query — the
  `ZINCRBY` approach is the only one of the two that scales to
  thousands of score-changing events per second.
- Gains: no drift-detection or reconciliation logic needed at all —
  the value in Redis is always exactly what Postgres says, checked by
  the rebuild endpoint actually regenerating identical state from
  scratch.
- Worth switching to incremental updates when per-event write volume
  is high enough that an aggregate query per event becomes real load
  on Postgres — not at this project's one-write-per-real-submission
  rate.

---

### 2. Ordering a derived-store write against the transaction that produced it

**The problem**: when a fast, non-transactional store (a cache, a
search index, a leaderboard) is kept in sync with a transactional
source of truth, a write to the derived store that happens *before*
the source-of-truth transaction is guaranteed to commit can leave the
derived store showing a value the source of truth never actually
confirmed.

**How this project does it**: `LeaderboardService.onProgressUpgraded`
is `@TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)`
— it fires only once `AttemptFinalizer.finalizeVerified`'s surrounding
Postgres transaction has actually committed, never mid-transaction. A
plain `@EventListener` was considered and rejected for firing while
the transaction that produced the upgrade might still roll back. See
`decisions.md` #3 and `explain_leaderboard.md`'s write-path diagram.

**Industry approaches**: this exact hazard — sometimes called the
"dual write problem" — is widely discussed in distributed-systems
writing about keeping two different stores consistent without
two-phase commit. The commonly cited mitigation at larger scale is the
**transactional outbox pattern** (documented by Chris Richardson's
microservices.io catalog, and implemented in practice via
change-data-capture tools like Debezium reading a database's own
commit log): write the "event to publish" as a row in the same
transaction as the real change, then a separate process reads
committed rows and publishes from there, guaranteeing publish-after-
commit without relying on application-level event-phase timing.
Spring's own `@TransactionalEventListener(phase = AFTER_COMMIT)`,
which this project uses directly, is the framework's documented,
lighter-weight answer to the same ordering problem for **in-process**
listeners — no separate outbox table or CDC process needed because
publisher and listener share one JVM and one transaction manager. This
isn't quite either of the classic read-cache patterns (cache-aside
populates a cache lazily on a read miss; write-behind writes to the
cache first and the durable store second, the opposite order from what
happens here) — Redis here is a derived materialized view kept in sync
by a domain event, closer in shape to the outbox/CDC pattern above,
just collapsed into a single in-process listener because there's no
network boundary between the two stores to protect against.

**Why this project differs (or doesn't)**: this is the same ordering
industry uses, at the appropriate weight class for where the two
stores live. `decisions.md` #3 draws the direct comparison itself:
`AFTER_COMMIT` gets "the exact same 'commit the real thing, then
update the derived cache' ordering `AttemptFinalizer` already uses
between `Attempt.status = SUBMITTED` and `problem_progress`, just at
the Postgres/Redis boundary instead of within Postgres." A full outbox
table + CDC pipeline would solve the same problem with far more
infrastructure than a single-process Spring listener needs — Postgres
and Redis are both reachable from the same JVM here, so there's no
network partition between "record the intent to update the cache" and
"update the cache" for an outbox to protect against.

**Trade-offs**:
- Gives up: no durable record of "this leaderboard update was supposed
  to happen" if the JVM crashes between Postgres's commit and the
  `AFTER_COMMIT` listener actually running — an outbox+CDC pipeline
  would survive that crash and eventually publish anyway; this
  project's rebuild endpoint is the only recovery path if that
  happens.
- Gains: no outbox table, no CDC connector, no separate publishing
  process to operate — the ordering guarantee comes from one
  annotation on one method.
- Worth adopting an outbox if `verify`/`leaderboard`-style updates ever
  need to survive a process crash between commit and side-effect
  without a manual rebuild, or once the producer and consumer are in
  genuinely different processes across a network.

---

### 3. Domain events for one-directional decoupling between features

**The problem**: when one part of a system needs to react to a change
in another part, something has to decide which side depends on the
other — a direct call from the source of truth's code into the
reacting code couples the two together, in both directions of change.

**How this project does it**: `ProblemProgressService.recordOutcome`
publishes `ProblemProgressUpgradedEvent(userId)` — a plain record
carrying only a user id — from the `progress` package.
`leaderboard.LeaderboardService` listens; `progress` has no knowledge
`leaderboard` exists. The event was kept deliberately minimal so a
future listener needing more data re-reads `problem_progress` itself
rather than the event growing a payload only one listener needs. See
`decisions.md` #2.

**Industry approaches**: this is a direct instance of the **domain
event** pattern from Domain-Driven Design (Eric Evans; elaborated by
Vaughn Vernon in *Implementing Domain-Driven Design*) — one bounded
context announces a fact about itself without knowing or caring who,
if anyone, is listening. On the specific "thin id-only payload vs. the
full changed data" choice, Martin Fowler's writing on event-driven
architecture (*"What do you mean by 'Event-Driven'"*) names exactly
this fork: **event notification** (a small message saying "something
happened, go look if you need details" — what this project does) vs.
**event-carried state transfer** (the event itself carries the full
changed record, so listeners never need to call back to the source).
The same one-directional-dependency reasoning is why many
microservices architectures route inter-service events through a
broker (Kafka, SNS/SQS, RabbitMQ) rather than services calling each
other's APIs directly — the broker, like this project's in-process
`ApplicationEventPublisher`, is the one place that knows about both
sides.

**Why this project differs (or doesn't)**: same reasoning as DDD's
domain events and Fowler's event-notification style, deliberately —
`decisions.md` #2 states the goal explicitly: keep `progress` and
`leaderboard` from depending on each other in both directions, and
keep the event thin enough that "Phase 7 (streaks) can listen to the
exact same event without `progress` changing at all." Where this
project is lighter than a typical microservices setup: the event
travels through Spring's in-process `ApplicationEventPublisher`, not a
message broker, because `progress` and `leaderboard` are two packages
in one JVM, not two separate services across a network — there's
nothing here that needs durability, at-least-once delivery guarantees,
or cross-process transport.

**Trade-offs**:
- Gives up: no durability if the event fires and the process crashes
  before every listener finishes — an in-process event is gone if the
  JVM dies mid-dispatch; a broker-backed event would be redelivered.
- Gains: zero infrastructure (no broker, no topic/queue config, no
  serialization format to version) for a decoupling need that's
  entirely about compile-time package dependencies, not runtime
  process boundaries.
- Worth moving to a real broker if `leaderboard` (or a future
  listener) ever needs to live in a separate deployable process from
  `progress` — at that point "in-process event" stops being available
  as an option at all, not just less convenient.

---

### 4. Normalizing a heterogeneous per-scenario metric into one global comparable score

**The problem**: ranking users across many different tasks of varying
difficulty requires converting each task's raw performance number into
something comparable across tasks — a raw metric that means different
things on different tasks (elapsed seconds against different time
limits, here) can't be averaged or summed meaningfully as-is.

**How this project does it**: the fastest-solved board's score is the
*average* `bestSpeedFactor` — the same per-solve multiplier
`PointsCalculator` already computes, factoring in both how close to
the time limit an attempt finished and the scenario's own difficulty
weighting — not raw elapsed seconds. `decisions.md` #4 states directly
that raw seconds "can't be meaningfully compared across scenarios of
different difficulty and time limits."

**Industry approaches**: normalizing heterogeneous performance into
one comparable rating is a long-standing, well-documented problem in
competitive ranking systems. Chess rating systems convert "beat this
specific opponent" into one portable number rather than tracking raw
win/loss counts, specifically so performance against different
opponents is comparable — FIDE's official over-the-board ratings use
the original Elo system; chess.com's online ratings publicly document
using Glicko/Glicko-2 instead, a refinement that also tracks a
confidence interval around each rating, not just the number itself.
Competitive programming judges like
Codeforces use a publicly documented rating algorithm that adjusts a
contestant's rating based on the *relative* difficulty of the
contest field, not raw solve count or solve time, for the same reason.
Kaggle's competition rankings similarly convert placement within each
competition into a points contribution that accounts for that
competition's own size and duration rather than comparing raw scores
across competitions directly.

**Why this project differs (or doesn't)**: same normalization
instinct as these systems, at a much simpler mechanism — this project
reuses an existing single-attempt multiplier (`speedFactor`) that
`PointsCalculator` already had to compute for a different reason
(points-per-solve), rather than building a dedicated rating algorithm.
`decisions.md` #4 is explicit that this was a reuse decision, not a
from-scratch design: reusing `speedFactor` means "fastest-solved and
best-solved can never disagree about which of two solves on the *same*
scenario was faster." Elo/Glicko and Codeforces-style ratings solve a
harder version of this problem — they update dynamically based on
who's competing against whom, with rating volatility and confidence
intervals — because their comparison is inherently relative
(opponent-vs-opponent), not because a simpler fixed per-attempt
multiplier wouldn't have been more work to build here too.

**Trade-offs**:
- Gives up: no accounting for how rating-worthy a given scenario "field"
  is over time (an Elo-style system adjusts for who else is playing,
  or how many people have solved a scenario); `speedFactor` is a fixed
  per-scenario function, so it can't capture "this scenario turned out
  to be much harder than its stated difficulty suggested" the way a
  dynamically-adjusting rating would.
- Gains: no rating-update algorithm, no convergence/volatility
  tuning, no separate rating store — the number already existed for
  points calculation, so reusing it is free correctness (see
  `decisions.md` #4's point about the two boards never disagreeing).
- Worth adopting a dynamic rating system if scenario difficulty
  weighting ever needs to reflect real solver population outcomes
  rather than being set by hand at scenario-authoring time — not
  something this project's scenario catalog size or solver volume
  currently demands.

---

### 5. Full rebuild-from-source as the correctness safety net for a derived store

**The problem**: any derived store that's kept in sync incrementally
(or even idempotently, but still only in response to specific events)
needs a way to recover if it's ever wiped, corrupted, or suspected to
have drifted — some mechanism to regenerate it entirely from whatever
is actually authoritative.

**How this project does it**: `POST /admin/leaderboard/rebuild`
(ADMIN-only) calls `LeaderboardService.rebuildAll()`, which finds
every user with at least one eligible `problem_progress` row and runs
the same `refreshUser` logic normal updates use, for all of them.
`LeaderboardIntegrationTest` actually wipes Redis and asserts this one
call regenerates identical state — not a hypothetical safety net. See
`decisions.md` #1 and `explain_leaderboard.md`'s "Rebuilding from
scratch" section.

**Industry approaches**: this is the same shape as **reindexing** in
search infrastructure — Elasticsearch's own documented Reindex API
exists specifically to rebuild an index from a source of truth (or
another index) when the index needs to be regenerated, and
"rebuild the search index from the database" is standard operational
practice at any company running Elasticsearch or Algolia in front of a
primary datastore. In event-sourced systems, the analogous operation
is **projection rebuild**: CQRS/event-sourcing literature (Greg
Young's writing on event sourcing; documented by frameworks like Axon)
describes read models as disposable, always reconstructable by
replaying the append-only event log from the beginning — a different
mechanism (replay a log vs. re-aggregate a relational table) aimed at
the same guarantee this project's rebuild endpoint provides.

**Why this project differs (or doesn't)**: same guarantee, deliberately
built as proof rather than assumption — `explain_leaderboard.md`
calls the rebuild endpoint "the practical proof of decisions.md #1's
central claim: Redis here is disposable, not authoritative," and the
integration test exercises the actual wipe-and-regenerate cycle rather
than only asserting the endpoint returns 200. The difference from
Elasticsearch reindexing or CQRS projection rebuild is scale and
mechanism, not intent: this project rebuilds by re-running the same
per-user aggregate query used for normal updates, sequentially, for
every eligible user, because that's a query over a Postgres table with
this project's actual row count — no need for the batching, backpressure,
or zero-downtime index-swap machinery a production search-index
reindex needs at millions of documents.

**Trade-offs**:
- Gives up: no zero-downtime guarantee during a rebuild — Redis is
  fully consistent again after the loop completes, but a read that
  happens mid-rebuild could see a partially-repopulated board (some
  users refreshed, some not yet); Elasticsearch's reindex-then-alias-
  swap pattern avoids exposing a partial index at all. The rebuild
  also runs sequentially, one query and one `ZADD` set per user, no
  batching or parallelism.
- Gains: the whole mechanism is a loop calling the same function
  normal updates use — no separate rebuild-specific code path to keep
  correct, and no infrastructure (index aliases, batch job scheduler)
  beyond one admin endpoint.
- Worth adopting batching/parallelism, or a swap-in-a-fresh-index
  approach, once the eligible-user count is large enough that a
  sequential rebuild takes long enough to matter operationally — not
  at a row count a single sequential loop finishes quickly on.

---

## Summary

For a project at this scale, the recompute-and-overwrite leaderboard,
the in-process domain event, and the reused `speedFactor` normalization
are all clearly the right calls — each gives up a capability (very
high write throughput, cross-process durability, dynamic
difficulty-aware rating) this project has no current use for, in
exchange for meaningfully less code and, in the recompute case,
correctness that's easier to reason about than the industry-standard
alternative would be here. The `AFTER_COMMIT` ordering and the rebuild
endpoint are places where this project reaches for the *lightweight*
version of a real industry pattern (outbox-style ordering without an
outbox; reindex-style rebuild without reindex-scale batching) rather
than skipping the underlying idea — both are genuinely proportionate
to a single-JVM, Postgres-row-count-in-the-thousands system, not a
corner cut. The one place worth naming as a real, currently-accepted
gap rather than a non-issue: the rebuild endpoint is this project's
only recovery path if the JVM crashes between Postgres's commit and
the `AFTER_COMMIT` listener running (section 2) — acceptable because
that gap already has a working, tested recovery mechanism (section 5),
but worth remembering it's a manual-trigger recovery, not an automatic
one, if this project ever needs to explain what happens during an
actual crash rather than only in a clean test run.
