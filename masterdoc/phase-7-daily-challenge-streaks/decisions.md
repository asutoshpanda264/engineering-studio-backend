# decisions.md — Phase 7: Daily Challenge + Streaks

Decisions specific to the new `dailychallenge` package (and the small
seams it needed in `progress`/`auth`). Project-wide decisions live in
`masterdoc/decisions.md`.

---

## 1. Daily-challenge assignment: AUTO (random, from PUBLISHED scenarios) now; ADMIN override wired up but unused; the reminder-notification piece deliberately not built

- **The product intent, as described by the user:** an admin ("the
  setter") is meant to curate each day's challenge ahead of time, with a
  10pm reminder notification if a future date is still unset, and a
  random fallback from the existing problem set if the deadline passes
  with nothing set.
- **Chose, for this milestone:** the random-fallback half of that design,
  built as the actual default behavior — `DailyChallengeService` picks
  uniformly at random from PUBLISHED scenarios the first time any date is
  needed (a `GET` request or a solve) and nobody had assigned one yet,
  persists it via a race-safe upsert, and reuses that same pick on every
  later request for that date. `POST /admin/daily-challenge/{date}`
  exists as the real, working "admin explicitly assigns/overrides a date"
  half of the design — it's not a stub, it fully works — but nothing yet
  drives it automatically or reminds anyone to call it.
- **Deliberately NOT built:** the 10pm reminder notification to "the
  setter." This project has no notification/email delivery mechanism, no
  scheduler/cron infrastructure, and no dedicated "challenge setter" role
  distinct from plain ADMIN — building a real reminder pipeline is a
  separate, larger piece of infrastructure than "assign today's
  scenario," and a fake/half-wired notification with nothing real to
  deliver to would be worse than being explicit that this is deferred.
- **Scenario it covers:** `AdminDailyChallengeController`'s own Javadoc
  states this explicitly, so a reader hitting that endpoint later
  understands why there's no reminder system next to it, rather than
  assuming it was forgotten.

## 2. Random, not deterministic-by-date — genuine `ThreadLocalRandom`, not a hash of the date

- **Chose:** `pickRandomPublishedScenarioId` uses `ThreadLocalRandom.current().nextInt(...)`
  over the current PUBLISHED list, persisted via the same race-safe
  upsert `ProblemProgressRepository.ensureRowExists` established in Phase
  5 (`INSERT ... ON CONFLICT (challenge_date) DO NOTHING`, then re-read).
- **Considered:** a deterministic function of the date (e.g. a hash of
  the ISO date string mod scenario count), so the same date always
  resolves to the same scenario even before it's ever been requested —
  useful for reproducibility, but nobody asked for that property, and a
  predictable rotation is also more guessable/gameable than genuine
  randomness for no real benefit here.
- **Why this instead:** matches the actual product language ("a random
  question... will be assigned") directly, and is simpler code — no hash
  function to get right, no need to reason about hash distribution across
  a 32-scenario catalogue. The idempotency (same date always returns the
  same scenario on every later request) comes from persisting the pick
  the first time, not from the pick itself being reproducible before
  that.

## 3. Two separate solved-events, not one generic one: `ScenarioSolvedEvent` (broad) vs `ProblemProgressUpgradedEvent` (narrow, Phase 6)

- **Chose:** `ProblemProgressService.recordOutcome` now publishes
  `ScenarioSolvedEvent` unconditionally whenever `gatesPassed` is true —
  before the mode/upgrade branching, so it fires for NO_PRESSURE and
  TIMED, first-ever solves and re-solves alike. `ProblemProgressUpgradedEvent`
  (Phase 6) is untouched, still firing only on a genuine TIMED,
  `delta > 0` upgrade.
- **Considered:** generalizing `ProblemProgressUpgradedEvent` into one
  richer event (carrying `gatesPassed`, `upgraded`, `mode`, ...) that both
  `LeaderboardService` and `DailyChallengeService` filter for themselves.
- **Why this instead:** the two events represent genuinely different
  facts, matching a real product distinction confirmed directly by the
  user — leaderboard eligibility is deliberately narrower (TIMED + a real
  improvement) than streak eligibility (any passing solve, any mode).
  Naming two precise events for exactly what each represents reads more
  honestly than one generic event every listener has to re-derive its own
  meaning from. It also meant Phase 6's already-shipped, already-tested
  `LeaderboardService`/`ProblemProgressUpgradedEvent` pair needed zero
  changes — a real, working mechanism from a prior phase stayed untouched
  rather than being refactored for a new, unrelated need.
- **Scenario it covers:**
  `DailyChallengeIntegrationTest.noPressureSolveOfTodaysChallengeStillMaintainsTheStreak`
  proves the broader event's actual effect; Phase 6's own leaderboard
  tests, re-run unaffected, prove the narrower one still means what it
  always meant.

## 4. A plain `@EventListener`, not `@TransactionalEventListener(AFTER_COMMIT)` — the opposite call from Phase 6, for a precise reason

- **Chose:** `DailyChallengeService.onScenarioSolved` is a plain
  `@EventListener` (default phase — fires synchronously, inline, in
  whatever transaction is already open when `publishEvent` is called).
- **Considered:** the same `@TransactionalEventListener(phase = AFTER_COMMIT)`
  Phase 6's `LeaderboardService` uses.
- **Why this instead:** Phase 6 needed AFTER_COMMIT because Redis sits
  outside any `PlatformTransactionManager`'s reach — it can't roll back
  if the Postgres transaction that triggered it later fails, so Postgres
  has to commit FIRST. That reasoning simply doesn't apply here: a
  `daily_challenge_completions` row and a `User.currentStreak` update are
  BOTH ordinary Postgres writes, and belong in the SAME transaction as
  the `ProblemProgress` write that triggered them — for the exact reason
  `PointsLedgerEntry` does (Phase 5): a scenario marked SOLVED with its
  streak silently unrecorded, or vice versa, would be a real
  data-integrity bug, not a merely-eventually-consistent cache lag.
- **A genuinely nice testability consequence:** because this listener's
  writes are ordinary same-transaction Postgres writes,
  `DailyChallengeIntegrationTest` needed NONE of
  `LeaderboardIntegrationTest`'s `@Transactional(propagation = NOT_SUPPORTED)`
  + manual-cleanup ceremony — it extends `AbstractIntegrationTest` exactly
  like `ProblemProgressIntegrationTest` does, and every row it creates
  rolls back automatically at the end of each test method. Only
  `DailyChallengeConcurrencyTest` (proving the race guarantee with two
  genuinely separate connections) needs that exception, for the same
  reason `ProblemProgressConcurrencyTest` (Phase 5) does.

## 5. Streak idempotency: the SAME two-part pattern as points (Phase 5), reused rather than re-invented

- **Chose:** `daily_challenge_completions.UNIQUE(user_id, challenge_date)`
  is the idempotency anchor (same shape as `points_ledger.attempt_id
  UNIQUE`, Phase 5) — `tryRecordCompletion`'s `INSERT ... ON CONFLICT DO
  NOTHING` returns 0 rows affected if today was already completed, and
  the streak math only runs when it returns 1. The streak mutation itself
  reads the `User` row via `UserRepository.lockById`
  (`@Lock(PESSIMISTIC_WRITE)`) — the exact same pattern as
  `ProblemProgressRepository.lockByUserIdAndScenarioId`.
- **Why reuse rather than re-derive:** this is precisely the class of bug
  Phase 5's `ProblemProgressConcurrencyTest` spent real effort proving a
  fix for (see that phase's decisions.md #3 — the honest finding that a
  timing-based test alone gives false confidence, and the deterministic
  test built to actually prove the lock blocks). `DailyChallengeConcurrencyTest`
  proves the END-TO-END guarantee this phase's own code needs
  (two-simultaneous-solves-never-double-increment) but doesn't re-prove
  that `@Lock(PESSIMISTIC_WRITE)` itself blocks a concurrent reader — that
  mechanism was already proven directly and deterministically once, and
  re-proving it here would just be the same test with different table
  names.

## 6. A real Hibernate first-level-cache staleness bug, caught by actually running the test — not assumed away

- **What happened:** `adminCanOverrideAnAlreadyAutoAssignedDate` failed
  on its first real run: `POST /admin/daily-challenge/{date}` returned
  204 (the native `UPDATE` genuinely ran and committed), but the very
  next `GET /daily-challenge/today` in the SAME test method still
  returned the OLD, pre-override scenario.
- **Why:** `DailyChallengeIntegrationTest` runs its whole test method
  inside one wrapping transaction (`AbstractIntegrationTest`'s default),
  so every MockMvc call in that method shares one Hibernate persistence
  context. The first `GET /daily-challenge/today` call had already loaded
  and cached a `DailyChallenge` entity for that date. `adminAssign`'s
  native `UPDATE` changed the row in Postgres directly — Hibernate has no
  way to know a native query touched an entity it's already tracking, so
  the next plain `findById` for that same date returned the stale cached
  instance instead of re-querying.
- **Why `ProblemProgressRepository.ensureRowExists` (Phase 5) never hit
  this:** its own follow-up read is `@Lock(PESSIMISTIC_WRITE)` — a
  locking query can't be satisfied from the first-level cache alone, it
  has to reach the database regardless of what's already cached. Both of
  `DailyChallengeRepository`'s native queries are followed by a PLAIN
  `findById`, which can be (and was) answered from cache.
- **The fix:** `@Modifying(clearAutomatically = true)` on both
  `tryAutoAssign` and `adminAssign` — evicts the persistence context
  immediately after the native query runs, forcing every subsequent read
  in that same transaction to hit the database.
- **Scenario it covers:** the general lesson — a native `@Modifying`
  query followed by a plain identity read (`findById`/`getById`, not a
  locking query) in the SAME transaction is exactly the shape that hits
  this, and is worth checking for specifically whenever a future phase
  adds another native upsert.

## 7. Admin override is allowed even after AUTO-assignment — a known, accepted caveat

- **Chose:** `adminAssign` is a genuine upsert (`ON CONFLICT DO UPDATE`),
  not a "fail if already set" operation — an admin can always override a
  date, whether it was previously AUTO-picked or ADMIN-set.
- **Known caveat, accepted rather than solved:** if users have ALREADY
  completed the AUTO-picked scenario for that date before an admin
  overrides it, their `daily_challenge_completions` rows still reference
  the OLD `scenario_id` while `daily_challenges` now points at the NEW
  one — a real, visible inconsistency for anyone who solved before the
  override. Blocking an override once completions exist, or retroactively
  reconciling them, would add real complexity for a scenario this
  project's actual usage pattern (a solo developer, admin overrides
  happening well before anyone plays that day, if ever) makes unlikely to
  matter in practice. Documented here rather than solved, matching this
  project's general practice of being explicit about accepted edge cases
  instead of quietly not handling them.

## 8. `UserResponse` finally exposes the streak fields Phase 1 already reserved for it

- **Chose:** added `currentStreak`, `longestStreak`, `lastSolveDate` to
  `UserResponse` (returned from `GET /me`), rather than a separate
  streak-specific endpoint.
- **Why:** `AuthController.me`'s own Javadoc has said "email, displayName,
  streak" since Phase 1 — the fields existed on `User` from the very
  first migration specifically for this, they just had no real logic
  behind them until this phase. `GET /daily-challenge/today/me` only
  answers "did I complete today's" — the streak numbers themselves belong
  with the rest of a user's own profile data, not duplicated into a
  second endpoint.
