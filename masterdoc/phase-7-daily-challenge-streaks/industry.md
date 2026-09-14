# industry.md — Phase 7: Daily Challenge + Streaks

How real-world systems solve the same problems this phase solved, and how
this project's approach compares. See `decisions.md` for why each choice was
made and `explain_dailychallenge.md` for how the mechanisms actually work —
this file adds the external comparison only.

---

### 1. A global "one item per calendar date," assigned lazily on first access

**The problem**: a product feature that shows every user the same single
item for a given calendar date needs a way to decide what that item is —
either compute it deterministically from the date itself, or pick it once
and remember the pick — without a race between the first few concurrent
requests for a brand-new date each independently deciding something
different.

**How this project does it**: `DailyChallengeService.getOrAutoAssign`
checks for an existing `daily_challenges` row for the date; if absent, it
picks a random PUBLISHED scenario, persists it via a race-safe
`INSERT ... ON CONFLICT (challenge_date) DO NOTHING`, then re-reads —
so a concurrent caller who loses that race still gets whichever pick
actually landed, not their own. See `explain_dailychallenge.md`'s
"get-or-auto-assign" flow and `decisions.md` #2.

**Industry approaches**: Wordle is the widely-known, publicly
reverse-engineered example of the opposite choice — its daily word is
picked deterministically from a fixed word list indexed by the number of
days since a launch epoch, computed client-side with no server round trip
at all, specifically so the same date always resolves to the same word
even offline or before anyone requests it. The general "compute-once,
cache-and-reuse" shape this project uses instead is the standard
cache-stampede / "dogpile" prevention pattern from caching systems
(memcached, Redis): the first request to miss a key computes and stores
the value, every other concurrent miss waits for or re-reads that same
stored value, rather than each one recomputing independently.

**Why this project differs (or doesn't)**: it's a deliberate choice against
the Wordle-style deterministic approach, not an oversight — `decisions.md`
#2 states directly that a hash-of-date function was considered and rejected
specifically because nobody asked for date-to-scenario reproducibility, and
because genuine randomness is both simpler to reason about and less
guessable than a fixed rotation. The get-or-create race-handling itself
matches the standard cache-stampede pattern for the same reason any
"compute once, reuse for every later reader" system needs it: without the
`ON CONFLICT DO NOTHING` + re-read, two simultaneous first-requesters for a
new date could each persist a different random pick and race on which one
wins, which is exactly the kind of bug the upsert exists to close.

**Trade-offs**:
- Gives up: a Wordle-style deterministic pick would let any client
  precompute "what will today's challenge be" without a database read at
  all (and would make the answer reconstructable/auditable purely from the
  date, with no need to store it) — this project's genuine randomness means
  the assignment only exists once it's actually been persisted.
- Gains: simpler code (no hash function or distribution-quality reasoning
  over a 32-scenario catalogue to get right) and a pick that can't be
  guessed or precomputed ahead of the reveal, matching the actual product
  language of "a random question will be assigned."
- Worth revisiting if: a requirement ever needs the same date to
  provably resolve to the same scenario even before any request touches it
  (e.g. pre-generating a week of challenges for a marketing calendar) —
  that's the point a deterministic function of the date would earn its
  complexity over the current lazy-assignment approach.

### 2. Consecutive-day streak counting, snapped to "yesterday"

**The problem**: rewarding sustained daily engagement requires counting
consecutive calendar days of activity, correctly resetting to zero (or one)
the moment a day is skipped, without letting a user's own client-reported
timing manipulate the count.

**How this project does it**: on a user's first completion of today's
challenge, `currentStreak` increments only if `lastSolveDate` was exactly
yesterday; otherwise it resets to 1. `longestStreak` tracks the running
maximum. All three fields (`currentStreak`, `longestStreak`,
`lastSolveDate`) live directly on `User`, computed from the server's own
`Clock`-derived date, not anything client-supplied. See
`explain_dailychallenge.md`'s "write path" section for the algorithm
itself — there's no dedicated `decisions.md` entry for the
streak-counting logic specifically (`decisions.md` #8 covers a related
but different choice: exposing these fields via `GET /me` rather than a
new endpoint, once the algorithm already existed).

**Industry approaches**: this is the same core algorithm behind the
best-known consumer streak features. Duolingo's streak counter (widely
discussed in its own product documentation and support articles) works on
the identical "did you engage since your last calendar day, or did the
streak break" logic, with its well-documented "streak freeze" feature as an
explicit, deliberate exception layered on top of the same base rule.
GitHub's own profile page doesn't natively display a streak counter —
but a whole ecosystem of popular third-party tools (e.g.
`github-readme-streak-stats`, widely embedded in README profiles) computes
one from GitHub's public contribution-graph data using this exact
consecutive-calendar-day counting shape, which is telling on its own:
the underlying data (a calendar of daily activity) is common enough that
the same streak algorithm gets bolted on by the community even where the
platform itself never built it. Snapchat's "Snapstreak" is the same
pattern applied to a pairwise (two-user) activity instead of a single
user's own history.

**Why this project differs (or doesn't)**: it's the same algorithm at its
core, minus the extra product features layered on top by those
consumer apps — no streak-freeze/grace-day mechanic, no push notification
reminding a user their streak is about to lapse (`decisions.md` #1 names
that reminder piece as explicitly out of scope for this phase, for
infrastructure reasons unrelated to the streak math itself).

**Trade-offs**:
- Gives up: no forgiveness mechanic for an accidentally-missed day (a
  Duolingo-style streak freeze), and no proactive reminder before a streak
  is about to lapse — a user finds out their streak broke only the next
  time they check, not in advance.
- Gains: the streak rule itself is a single, easily-auditable branch
  (yesterday → increment, else → reset) with no separate freeze-inventory
  state to track, test, or explain to users.
- Worth revisiting if: user retention data ever showed streak breaks
  driving people away right at the reset point — that's the actual product
  reason streak-freeze features exist in apps like Duolingo, and would be
  the trigger to add one here, not a technical limitation of the current
  design.

### 3. Idempotent completion recording via a unique constraint, reused from Phase 5's exact pattern

**The problem**: an action that must be credited at most once per
user-per-day (regardless of retries, duplicate requests, or concurrent
racing calls) needs a way to detect "already done" and skip re-crediting,
without a separate existence check that itself races.

**How this project does it**: `daily_challenge_completions.UNIQUE(user_id,
challenge_date)` is the idempotency anchor; `tryRecordCompletion`'s
`INSERT ... ON CONFLICT DO NOTHING` returns 0 affected rows if today was
already completed, and the streak math only runs when it returns 1 — the
same two-part pattern (unique-constraint anchor + conditional-insert gate)
`points_ledger.attempt_id UNIQUE` established in Phase 5, deliberately
reused rather than re-invented. See `decisions.md` #5.

**Industry approaches**: a database uniqueness constraint as the single
source of truth for "has this already happened" is a standard,
widely-documented idempotency technique — it's the same shape Stripe's
publicly documented `Idempotency-Key` header relies on internally (a unique
key per logical operation, with a conflicting second attempt returning the
original result rather than creating a duplicate charge). Message-queue
consumers reach for the identical pattern under the name "exactly-once
processing via a dedup table": Kafka consumers and AWS SQS FIFO queues'
deduplication IDs both boil down to "a unique constraint (or unique-key
lookup) on the thing that must not be double-processed, checked
atomically at write time."

**Why this project differs (or doesn't)**: it doesn't differ — this is
the direct industry pattern, and the reuse is itself the interesting
decision: `decisions.md` #5 is explicit that Phase 5's
`ProblemProgressConcurrencyTest` already did the hard work of proving
`@Lock(PESSIMISTIC_WRITE)` genuinely blocks a concurrent reader with a real
deterministic test (not just a timing-based one that gives false
confidence), so Phase 7 only needed to prove the new end-to-end guarantee
(two simultaneous solves never double-increment a streak), not re-derive
the underlying locking mechanism from scratch.

**Trade-offs**:
- Gives up: nothing versus the pattern itself — this is the same technique
  Stripe and message-queue consumers use, not a simplified stand-in for it.
- Gains: cross-phase consistency (one idempotency shape used everywhere
  this project needs "at most once," from points to streaks) and less test
  surface — `DailyChallengeConcurrencyTest` only proves its own new
  end-to-end behavior, not a lock mechanism Phase 5 already proved once.
- Worth revisiting if: never, structurally — a unique constraint plus a
  conditional insert is already the industry-standard shape for this exact
  problem at any scale.

### 4. Two differently-scoped domain events from one underlying action

**The problem**: a single user action can have multiple downstream
consequences with genuinely different eligibility rules (not every
consequence should fire under the same conditions) — a system needs to
decide whether to model that as one generic event every listener
re-filters, or several precise events that each mean exactly one thing.

**How this project does it**: `ProblemProgressService.recordOutcome`
publishes `ScenarioSolvedEvent` unconditionally on any passing solve (any
mode, first-time or repeat), which `DailyChallengeService` listens to;
Phase 6's `ProblemProgressUpgradedEvent` — narrower, TIMED-only,
real-improvement-only — is untouched and still drives only the leaderboard.
See `decisions.md` #3.

**Industry approaches**: publishing distinct, precisely-named domain
events for distinct facts rather than one generic "something happened"
event is the standard guidance in event-driven architecture and Domain-Driven
Design literature (Martin Fowler's writing on domain events is the
widely-cited reference) — the reasoning given there is the same one this
project applied: a generic event forces every listener to re-derive its own
meaning from shared fields, while precisely-named events document intent at
the publish site. E-commerce systems commonly publish separate
`OrderPlaced`/`OrderShipped`/`OrderDelivered` events rather than one
`OrderChanged` event precisely so each downstream consumer (billing,
notifications, analytics) subscribes only to the fact it actually cares
about.

**Why this project differs (or doesn't)**: it doesn't differ — this is the
textbook justification for precise domain events, and `decisions.md` #3
gives the same reasoning literature on the topic gives, plus a concrete
project-specific payoff: Phase 6's already-shipped, already-tested
`LeaderboardService` needed zero changes to accommodate this phase's new
listener, because the two events cleanly separate leaderboard eligibility
(narrow) from streak eligibility (broad) at the publish site rather than
inside a shared listener's conditional logic.

**Trade-offs**:
- Gives up: nothing versus the pattern — two named events for two distinct
  facts is not a simplification, it's the standard approach done correctly.
- Gains: Phase 6's leaderboard code and tests stayed completely untouched
  while adding a new, unrelated consumer of the same underlying solve —
  the practical benefit precise domain events are meant to deliver.
- Worth revisiting if: the number of distinct "something happened, maybe
  someone cares" facts grows large enough that tracking many narrowly-scoped
  event types becomes its own maintenance burden — not a concern yet at two
  events.

### 5. Same-transaction side effects for a same-database consequence, contrasted with Phase 6's after-commit choice for a cross-system one

**The problem**: a side effect triggered by a database write needs to run
either inside the same transaction (so it can never be recorded
inconsistently with the write that caused it) or after that transaction
commits (when the side effect targets something outside the database's own
transactional guarantees) — picking the wrong one either risks silent data
loss or an effect based on data that later gets rolled back.

**How this project does it**: `DailyChallengeService.onScenarioSolved` is
a plain `@EventListener` (not `AFTER_COMMIT`), so the completion row and
streak update happen inside the SAME transaction as the `ProblemProgress`
write that triggered them — deliberately the opposite choice from Phase
6's `LeaderboardService`, which uses `@TransactionalEventListener(AFTER_COMMIT)`
because it writes to Redis, which sits outside Postgres's transactional
reach. See `decisions.md` #4.

**Industry approaches**: this is a small-scale instance of what's commonly
called the "dual-write problem" in distributed-systems writing (discussed
publicly by, among others, Confluent's engineering blog in the context of
keeping a database and a message broker/cache consistent) — writing to two
systems that don't share a transaction manager (a relational database and
Redis, or a database and a message queue) can't be made atomic by ordinary
means, so systems either accept eventual consistency with a defined commit
order (write the transactional store first, then the non-transactional one
after commit — exactly Phase 6's choice) or reach for heavier machinery
like the Transactional Outbox pattern to guarantee the second write
eventually happens. When both sides of an effect ARE the same
transactional database, no such problem exists at all — the standard
answer is simply "do it in the same transaction," which is what this
phase's own case is.

**Why this project differs (or doesn't)**: it doesn't differ — the two
phases made opposite listener-timing choices for the textbook-correct
reason each situation calls for: Phase 6 has a real dual-write problem
(Postgres and Redis) and handles it with the "commit first" ordering
industry writing describes; Phase 7 has no such problem (both the
completion row and the streak update are ordinary Postgres writes) and
correctly uses the simpler, stronger guarantee a shared transaction gives
for free. `decisions.md` #4 states this contrast explicitly rather than
applying Phase 6's pattern out of consistency-for-its-own-sake.

**Trade-offs**:
- Gives up: nothing — using a shared transaction when both sides are the
  same transactional database isn't a lesser version of the AFTER_COMMIT
  pattern, it's the objectively stronger and simpler guarantee available
  precisely because there's no dual-write problem to solve here.
- Gains: real atomicity (a scenario marked SOLVED with its streak silently
  unrecorded is now impossible, not just made unlikely) and a genuinely
  nice testability consequence — `DailyChallengeIntegrationTest` needed
  none of `LeaderboardIntegrationTest`'s `NOT_SUPPORTED`-propagation and
  manual-cleanup ceremony, since every write rolls back automatically like
  any other same-transaction test.
- Worth revisiting if: a future phase adds a third consequence of a solve
  that targets a non-transactional system (an email, a push notification,
  another cache) — that new listener would need Phase 6's AFTER_COMMIT
  treatment, not this phase's, for the same dual-write reason.

### 6. ORM identity-map staleness after a native bulk update — a documented cross-ORM pitfall, caught by running the test

**The problem**: an object-relational mapper that caches loaded entities in
memory (an "identity map" or first-level cache) can return a stale, already-loaded
copy of a row even after that row was changed directly at the database
level — because a raw/native SQL statement doesn't go through the layer
that would normally update the cached copy.

**How this project does it**: `adminAssign`'s native `UPDATE` genuinely
committed, but the very next plain `findById` for the same date, later in
the same test method's shared Hibernate persistence context, returned the
stale pre-override entity — a real bug caught on the test's first actual
run, not assumed away. The fix, `@Modifying(clearAutomatically = true)` on
both native upsert queries, evicts the persistence context immediately
after the native query runs, forcing the next read to hit the database.
`ProblemProgressRepository.ensureRowExists` (Phase 5) never hit this
because its follow-up read is a `@Lock(PESSIMISTIC_WRITE)` query, which
can't be satisfied from cache regardless. See `decisions.md` #6.

**Industry approaches**: this exact failure mode — an ORM's identity map
returning a stale object after a bypass write — is a widely-documented
pitfall across ORMs, not specific to Hibernate. Hibernate's own reference
documentation covers the underlying cause (the first-level cache/session
not knowing about a change made outside it) and its own generic fixes
(`EntityManager.clear()`/`refresh()`); `@Modifying(clearAutomatically =
true)` specifically is Spring Data JPA's own documented convenience
built on top of that same Hibernate mechanism, for exactly this
native-bulk-update-then-stale-read scenario. Rails' ActiveRecord has the
identical documented gotcha
with raw SQL (`update_all`/`exec_update`) not refreshing already-loaded
in-memory objects, with `reload` as the standard fix. The general principle
— any cache sitting in front of a data store needs an explicit
invalidation path for writes that don't go through the cache's own write
path — is the same one behind cache-invalidation guidance for Redis/memcached
layers in front of a database (a native/direct DB write bypassing an
application-level cache is the same shape of bug, one layer up).

**Why this project differs (or doesn't)**: it doesn't differ — this isn't
a project-specific design choice at all, it's a real bug that any Hibernate
(or any ORM's identity-map) user can hit under this exact shape (native
`@Modifying` query, then a plain identity read in the same transaction),
fixed with the framework's own documented mechanism for it.

**Trade-offs**:
- Gives up: nothing — there's no simplification here, just the standard
  fix for a standard ORM pitfall.
- Gains: a documented, generalizable lesson for the rest of the codebase
  (`decisions.md` #6 names the exact shape — native `@Modifying` followed
  by a plain identity read in the same transaction — as worth checking for
  whenever a future phase adds another native upsert), caught by actually
  running the integration test against real Postgres rather than assumed
  correct from the code alone.
- Worth revisiting if: never, structurally — this is a bug fix matching
  the framework's documented solution, not a trade-off with a "worth
  adopting the industry approach" threshold.

---

## Summary

This phase is almost entirely industry-standard technique applied at a
much smaller scale than the systems it resembles: idempotent completion
recording (#3) and precise domain events (#4) are the same patterns Stripe
and DDD literature describe outright, and the same-transaction-vs-
after-commit contrast with Phase 6 (#5) is the textbook-correct call in
both directions, not a corner cut in either one. The one genuinely
deliberate deviation from a well-known peer product is the daily
challenge's own assignment strategy (#1) — choosing real randomness over
Wordle's deterministic date-to-item mapping — and it's an honest,
well-reasoned
choice rather than a simplification forced by scale: nothing about this
project's size makes determinism harder to implement, it just wasn't the
actual product requirement. The streak algorithm itself (#2) is the same
consecutive-calendar-day math Duolingo uses (and that third-party tools
bolt onto GitHub's public contribution data, even though GitHub itself
doesn't build a streak feature), deliberately without the
retention-driven extras (streak freezes, lapse reminders) those consumer
products layer on top — a legitimate scope cut for a portfolio project
with no retention data to act on, not a gap in the core mechanism. Bug #6 is not a design
trade-off at all — it is the standard ORM pitfall with the standard fix,
worth keeping in mind (as `decisions.md` #6 already flags) any time a
future phase adds another native upsert next to a plain entity read.
