# decisions.md — Phase 6: Redis Leaderboards

Decisions specific to the `leaderboard` package (and the small seam it
needed in `progress`). Project-wide decisions live in
`masterdoc/decisions.md`.

---

## 1. Redis is a disposable, rebuildable *projection* — never the source of truth, never written incrementally

- **Chose:** every leaderboard write is "read this one user's current
  totals fresh from Postgres (`problem_progress`), then `ZADD` (overwrite)
  their membership in all three ZSETs to match." No `ZINCRBY` anywhere in
  this package. `LeaderboardService.rebuildAll()` — wired to
  `POST /admin/leaderboard/rebuild` — replays this for every eligible user
  from scratch, proving Redis can be wiped and fully regenerated at any
  time.
- **Considered:** incrementally adjusting each ZSET (`ZINCRBY` for
  most-solved's count, apply a computed delta for best-solved's points,
  maintain a running sum+count pair for fastest-solved's average) at the
  moment each `ProblemProgress` upgrade happens.
- **Why this instead:** an incremental approach means Redis's state is
  only ever correct if every single increment that was ever supposed to
  happen actually did, exactly once, in order — a dropped event, a retry,
  or a bug replaying an old event would drift Redis away from Postgres
  permanently, with no way to tell it had happened short of recomputing
  everything anyway. Recompute-and-overwrite is naturally idempotent: the
  same event handled twice, or a stale event handled out of order, lands
  on the exact same correct value both times, because it's always derived
  fresh from whatever Postgres actually says *right now*, never from
  Redis's own prior state. The cost — one small aggregate query per
  refresh instead of an O(1) increment — is irrelevant at this project's
  scale (one row read per user event, not per request).
- **Scenario it covers:** `LeaderboardIntegrationTest
  .rebuildAllRepopulatesRedisFromPostgresAfterItsWiped` — wipes all three
  ZSETs entirely, then proves a single admin call regenerates identical
  state from Postgres alone.

## 2. Update trigger: a domain event off `ProblemProgressService`, not a direct call

- **Chose:** `ProblemProgressService.recordOutcome` publishes a
  `ProblemProgressUpgradedEvent(userId)` — a plain record living in the
  `progress` package, not `leaderboard` — exactly where it already writes
  a `PointsLedgerEntry` (the `delta > 0`, TIMED-mode branch).
  `leaderboard.LeaderboardService` is the only current listener.
- **Considered:** `ProblemProgressService` calling
  `LeaderboardService.refreshUser(userId)` directly, the same way it
  already calls `PointsLedgerRepository`.
- **Why this instead:** a direct call would make `progress` depend on
  `leaderboard`, on top of `leaderboard` already needing to depend on
  `progress` (for `ProblemProgressRepository`'s aggregate query) — a
  two-way coupling between packages that are supposed to be independent
  features per `masterdoc/decisions.md`'s package-by-feature entry. An
  event keeps the dependency one-directional: `progress` doesn't know
  `leaderboard` exists at all, it just announces "this user's progress
  improved." This also means Phase 7 (streaks) can listen to the exact
  same event without `progress` changing at all — the event was kept
  deliberately minimal (just `userId`) for that reason; a listener that
  needs more re-reads `problem_progress` itself rather than the event
  growing a payload only one listener needs.
- **Scenario it covers:** the event is published unconditionally whenever
  a real upgrade happens, regardless of which listeners currently exist —
  adding Phase 7's streak listener later needs zero changes to `progress`.

## 3. The listener runs `AFTER_COMMIT`, not at the default (immediate) event phase

- **Chose:** `LeaderboardService.onProgressUpgraded` is annotated
  `@TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)`,
  firing only once the transaction that produced the upgrade has actually
  committed to Postgres.
- **Considered:** a plain `@EventListener`, which runs synchronously at
  the point `publishEvent` is called — i.e. still inside
  `ProblemProgressService.recordOutcome`'s open transaction, before
  `AttemptFinalizer.finalizeVerified`'s surrounding transaction commits.
- **Why this instead:** Redis isn't a JPA resource — no
  `PlatformTransactionManager` can roll a Redis write back if the
  surrounding Postgres transaction later fails for an unrelated reason
  (e.g. a later step in the same method throws). A plain `@EventListener`
  firing mid-transaction risks Redis showing a user's new best score
  while Postgres still shows the old one, if that transaction never
  actually commits. `AFTER_COMMIT` guarantees the order that actually
  matters: Postgres is written and durable *first*, Redis catches up
  *second* — the exact same "commit the real thing, then update the
  derived cache" ordering AttemptFinalizer already uses between
  `Attempt.status = SUBMITTED` and `problem_progress`, just at the
  Postgres/Redis boundary instead of within Postgres.
- **A real testing consequence, not just a theoretical one:**
  `AbstractIntegrationTest`'s default per-test-method `@Transactional`
  wraps every test in a transaction that **rolls back**, never commits —
  which means `AFTER_COMMIT` listeners silently never fire under the
  default test setup, not because anything is broken but because the
  event's condition for firing genuinely never occurs. This is invisible
  by default: an assertion checking Redis state would just see nothing
  and could easily be misread as "the feature doesn't work" rather than
  "the test harness never let it commit." `LeaderboardIntegrationTest`
  takes the same `@Transactional(propagation = NOT_SUPPORTED)` +
  manual-cleanup exception `ProblemProgressConcurrencyTest` already
  established (Phase 5) — see that class's own header comment for the
  precedent — specifically so its assertions are testing something real.

## 4. `fastest-solved`'s score is `PointsCalculator.speedFactor` (a multiplier), not raw elapsed seconds

- **Chose:** the fastest-solved ZSET's score is the *average*
  `bestSpeedFactor` across a user's leaderboard-eligible solves — the
  same per-solve value `ProblemProgress.bestSpeedFactor` already stores
  (Phase 5), which factors in both how close to the time limit the
  attempt finished AND the scenario's own difficulty weighting. Higher is
  better here, same as the other two boards.
- **Considered:** raw elapsed seconds (lower is better — a different
  ranking direction from the other two boards) or a per-scenario "fastest
  time" leaderboard (one ZSET per scenario, not 3 total).
- **Why this instead:** the milestone plan calls for exactly 3 ZSETs,
  global across all scenarios — raw seconds can't be meaningfully compared
  across scenarios of different difficulty and time limits (finishing a
  10-minute scenario in 5 minutes and a 30-minute scenario in 25 minutes
  are very different feats that raw-seconds averaging would rank
  backwards). `speedFactor` is already the exact number `PointsCalculator`
  uses to normalize "how fast, relative to what this specific scenario
  allows" into one comparable unit — reusing it here, rather than
  inventing a second speed metric, means fastest-solved and best-solved
  can never disagree about which of two solves on the *same* scenario was
  faster; they just weight that fact differently (best-solved multiplies
  it into points alongside difficulty and stars, fastest-solved reports it
  raw, averaged). Keeping "higher = better" uniform across all three
  boards is also what lets `LeaderboardService` use one ranking convention
  (`ZREVRANGE`/`ZREVRANK`) everywhere instead of two.
- **Scenario it covers:**
  `LeaderboardIntegrationTest.aFasterSolveOutranksASlowerOneOnBestAndFastestButTheyTieOnMostSolved`.

## 5. NO_PRESSURE solves are excluded via one WHERE clause, not a mode check in `leaderboard`

- **Chose:** `ProblemProgressRepository.aggregateLeaderboardStats` (and
  the sibling query listing eligible users for `rebuildAll`) filter on
  `bestSpeedFactor IS NOT NULL` — that field is set on *only* the TIMED,
  `delta > 0` branch of `recordOutcome`, so this single condition already
  excludes every NO_PRESSURE solve.
- **Considered:** an explicit `attempt.mode = TIMED` check inside
  `leaderboard`, requiring a join back to `Attempt` from the leaderboard
  read path.
- **Why this instead:** this isn't a new rule this milestone invented —
  `attempt.AttemptMode`'s own Javadoc has said "excluded from every
  leaderboard" about NO_PRESSURE since Phase 3, before `leaderboard`
  existed. `bestSpeedFactor IS NOT NULL` is the field that *already*
  encodes exactly that fact (it's only populated when a TIMED attempt
  produced a genuine upgrade), so re-deriving the same exclusion via a
  join elsewhere would be duplicating a rule instead of reading the one
  place it's already recorded.
- **Scenario it covers:**
  `LeaderboardIntegrationTest.noPressureSolveNeverAppearsOnAnyLeaderboard`.

## 6. No dedicated Testcontainers Redis module — a plain `GenericContainer`, verified against the actual BOM

- **What was checked, not assumed:** `testcontainers-bom:2.0.5` (the
  version this project's Spring Boot 4.1.1 parent pins) was grepped for
  every managed artifact — Postgres, MySQL, Kafka, MongoDB, and 50+
  others are there; no `testcontainers-redis` exists at all. Confirmed
  again by inspecting `spring-boot-testcontainers-4.1.1.jar` itself for a
  Redis-specific connection-details class — none. The actual support
  lives in `spring-boot-data-redis-4.1.1.jar`'s
  `RedisContainerConnectionDetailsFactory`, which matches any
  `org.testcontainers.containers.Container` whose image name is `redis`,
  `redis/redis-stack`, or `redis/redis-stack-server` — it doesn't need a
  typed container class at all, unlike Postgres's `PostgreSQLContainer`.
- **Chose:** `AbstractIntegrationTest` and `TestcontainersConfiguration`
  both declare `new GenericContainer<>(DockerImageName.parse("redis:7-alpine")).withExposedPorts(6379)`
  under a plain `@ServiceConnection` (no `value`/`type` arguments needed —
  the image-name match above is sufficient), the same shared-for-the-whole-JVM-run
  pattern already used for `POSTGRES`.
- **Scenario it covers:** this is exactly the kind of thing this
  project's own convention ("verify real package versions before pinning
  instead of guessing") exists to catch — guessing at a
  `testcontainers-redis` artifact coordinate would have failed at
  dependency resolution, not silently, but only after writing code around
  an artifact that doesn't exist.

## 7. Two real findings, both caught by actually running the tests against Docker

- **Finding A — a test bug, not a production one:** the first version of
  `timedSolvePlacesSolverOnAllThreeLeaderboardsWithScoresMatchingTheFormula`
  computed its expected `speedFactor` from the nominal
  `clock.advance(Duration.ofSeconds(300))` amount, not the attempt's
  actual persisted `elapsedSeconds`. The real value came back as 299, not
  300 — a sub-second sliver lost round-tripping `startedAt`/`submittedAt`
  through a real Postgres timestamp column between the two `clock.instant()`
  reads. `best-solved`'s integer points happened to round to the same
  value either way, so that assertion passed; `fastest-solved`'s raw,
  unrounded `speedFactor` assertion (tolerance 1e-4) caught the ~3e-4 gap
  immediately. **Fix:** the test now reads the attempt's actual
  `elapsedSeconds` back off the submit response and computes every
  expectation from that, not from the intended clock-advance amount.
- **Finding B — a real test-isolation gap this phase introduced into an
  already-passing Phase 5 test:** `ProblemProgressConcurrencyTest` also
  overrides `@Transactional(propagation = NOT_SUPPORTED)` (Phase 5, for
  its own reason — see that class's Javadoc), meaning its commits are
  real, not rolled back. Before this phase, that had no consequence
  beyond Postgres. After this phase, a real commit is exactly what
  `LeaderboardService`'s `AFTER_COMMIT` listener fires on — so that
  test's winning racer now silently became a permanent member of all
  three Redis ZSETs, every time the test ran, for the rest of that shared
  test-JVM's life (`AbstractIntegrationTest`'s containers are shared
  across every test class in one run). Its existing `@AfterEach` only
  ever needed to delete Postgres rows and had no reason to know about
  Redis. **Fix:** extended that cleanup to also remove the racer's
  membership from all three leaderboard ZSETs. Caught specifically
  because this project re-runs each already-passing earlier phase's test
  class after a change to shared infrastructure (the same practice that
  caught Phase 5's `AccessDeniedException` regression) rather than
  assuming "I only touched the `leaderboard` package."
- **Scenario both cover:** the general lesson worth remembering past this
  one phase — a new cross-cutting side effect (an event listener touching
  a *shared, not-per-test* resource) can silently make an existing test's
  incidental behavior wrong even though that test's own code, and its own
  assertions, never changed.

## 8. No new Flyway migration this phase

- **Chose:** nothing. `leaderboard` reads exclusively from the existing
  `problem_progress` table (Phase 5) and writes exclusively to Redis — no
  new Postgres table, column, or index was needed.
- **Scenario it covers:** worth stating explicitly rather than leaving it
  implicit, since every prior phase added at least one migration — a
  reader checking `db/migration/` for "what did Phase 6 add" would
  otherwise wonder if something was missed rather than genuinely absent.
