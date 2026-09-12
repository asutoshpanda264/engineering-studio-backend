# Phase 6 — Redis Leaderboards

**Status:** ✅ done, verified against a real Postgres + Redis via Testcontainers.

## What shipped

Three global Redis ZSETs — most-solved, best-solved, fastest-solved (see
`explain_leaderboard.md` for the exact score definitions) — kept in sync
with `problem_progress` via a domain event
(`ProblemProgressUpgradedEvent`, published from `ProblemProgressService`)
consumed by a `@TransactionalEventListener(phase = AFTER_COMMIT)` in the
new `leaderboard` package. `GET /leaderboards/{type}` (public, top-N) and
`GET /leaderboards/{type}/me` (authenticated, one user's own rank) expose
them; `POST /admin/leaderboard/rebuild` (ADMIN-only) wipes-and-regenerates
every board from Postgres. NO_PRESSURE-mode solves are excluded from every
board, honoring a rule `attempt.AttemptMode`'s own Javadoc has stated
since Phase 3.

No new Flyway migration — this phase reads only from `problem_progress`
(Phase 5) and writes only to Redis.

## Files in this repo

- `api/src/main/java/.../leaderboard/` — `LeaderboardType`,
  `LeaderboardService`, `LeaderboardController`, `dto/`
- `api/src/main/java/.../progress/ProblemProgressUpgradedEvent.java`,
  `ProblemProgressLeaderboardStats.java` (new); `ProblemProgressRepository`
  (two new aggregate queries), `ProblemProgressService` (publishes the
  event) (edited)
- `api/src/main/java/.../admin/AdminLeaderboardController.java`
- `api/src/main/java/.../config/SecurityConfig.java` (the
  `/leaderboards/*/me` authenticated carve-out) (edited)
- `api/src/main/resources/application.yml` (`spring.data.redis.*`) (edited)
- `api/pom.xml` (`spring-boot-starter-data-redis`) (edited)
- `api/src/test/java/.../support/AbstractIntegrationTest.java`,
  `TestcontainersConfiguration.java` (the shared Redis container) (edited)
- `api/src/test/java/.../leaderboard/LeaderboardIntegrationTest.java`,
  `LeaderboardTypeTest.java`

## Docs in this folder

- `decisions.md` — 8 entries: recompute-and-overwrite vs. incremental
  Redis writes, the domain-event trigger (and why the dependency only
  goes one direction), `AFTER_COMMIT` timing and its real testing
  consequence, why fastest-solved's score is a speed *factor* not raw
  seconds, how NO_PRESSURE exclusion reuses an existing column instead of
  a new mode check, the no-dedicated-Testcontainers-Redis-module finding,
  two real bugs actually caught while running the tests (one test-only,
  one a genuine cross-phase test-isolation gap this phase introduced),
  and the deliberate absence of a new migration.
- `explain_leaderboard.md` — the three boards' exact score definitions,
  the full write path from a submit to Redis actually changing (with the
  AFTER_COMMIT timing spelled out step by step), why recomputing beats
  incrementing, and how the read/rebuild endpoints work.

## Test status

- `LeaderboardTypeTest` — 3/3 (no Testcontainers, <1s)
- `LeaderboardIntegrationTest` — 6/6, real Postgres + Redis via
  Testcontainers, `@Transactional(propagation = NOT_SUPPORTED)` (same
  exception `ProblemProgressConcurrencyTest` already established, needed
  here so `AFTER_COMMIT` actually fires — see decisions.md #3)
- A real, honest bug caught while writing these tests, not a production
  one: the first version of `timedSolvePlacesSolverOnAllThreeLeaderboardsWithScoresMatchingTheFormula`
  computed its expected `speedFactor` from the nominal clock-advance
  amount (300s) instead of the attempt's actual persisted
  `elapsedSeconds` (299s — a sub-second sliver lost round-tripping
  `startedAt`/`submittedAt` through a real Postgres timestamp column
  between two clock reads). `best-solved`'s integer points masked the
  1-second gap; `fastest-solved`'s raw, unrounded `speedFactor` didn't —
  fixed by computing expectations from the attempt's actual persisted
  elapsed time instead of the intended one.
- A real test-isolation gap this phase introduced into an **already-passing
  Phase 5 test**, caught by re-running it (not assumed unaffected):
  `ProblemProgressConcurrencyTest` also uses
  `@Transactional(propagation = NOT_SUPPORTED)`, so its real (non-rolled-back)
  commit now also fires the new `AFTER_COMMIT` leaderboard listener — its
  existing cleanup deleted only Postgres rows, silently leaving that
  test's racer as a permanent Redis ZSET member across the whole shared
  test-JVM run. Fixed by extending its `@AfterEach` to also remove that
  member from all three boards.
- Re-verified unaffected, each individually per
  `masterdoc/explain_testing.md`: `AuthFlowIntegrationTest` (5/5 —
  `SecurityConfig`'s new `/leaderboards/*/me` matcher didn't disturb the
  existing rules), `ProblemProgressIntegrationTest` (5/5),
  `ProblemProgressConcurrencyTest` (2/2, after the fix above),
  `ScenarioCrudIntegrationTest` (6/6), `AttemptFlowIntegrationTest` (7/7),
  `ScenarioSeedMigrationTest` (3/3), `PointsCalculatorTest` (8/8).
