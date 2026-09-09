# Phase 5 — Points + PointsLedger + Upgrade-Only ProblemProgress

**Status:** ✅ done, verified against a real Postgres via Testcontainers — including a deliberately verified-both-directions concurrency guarantee.

## What shipped

The points formula (`PointsCalculator`, pure and independently unit
tested), a per-user-per-scenario `ProblemProgress` record that only ever
upgrades to a better result, and an append-only `PointsLedger` audit
trail. Wired into the existing attempt-submit flow (`AttemptFinalizer`) so
an attempt's SUBMITTED status and its points/progress consequences commit
or roll back together, atomically. `GET /progress/scenarios` and
`GET /progress/scenarios/{id}` expose it.

Also landed: a real, caught-and-fixed regression in shared error-handling
infrastructure (`GlobalExceptionHandler`), found by re-running Phase 1's
own test suite — see `decisions.md` #5.

## Files in this repo

- `api/src/main/java/.../points/` — `PointsCalculator`, `PointsLedgerEntry`,
  `PointsLedgerRepository`
- `api/src/main/java/.../progress/` — `ProblemProgress`,
  `ProblemProgressStatus`, `ProblemProgressRepository`,
  `ProblemProgressService`, `ProblemProgressController`, DTOs
- `api/src/main/resources/db/migration/V4__progress_and_points.sql`
- `api/src/main/java/.../common/error/GlobalExceptionHandler.java` (the
  `AccessDeniedException` fix)
- `api/src/test/java/.../points/PointsCalculatorTest.java`
- `api/src/test/java/.../progress/ProblemProgressIntegrationTest.java`,
  `ProblemProgressConcurrencyTest.java`
- `api/src/test/java/.../support/TestServiceOverridesConfig.java`,
  `FakeVerifyClient.java` (now mutable — extracted/upgraded this phase)

## Docs in this folder

- `decisions.md` — 5 entries: the pure-calculator design, the
  ensure-exists-then-lock concurrency pattern, a genuine lesson about how
  *not* to trust a timing-based concurrency test (and the deterministic
  test built to replace that trust), the transactional coupling with
  `AttemptFinalizer`, and the `AccessDeniedException` regression story.
- `explain_points.md` — the formula spelled out with intuition, the full
  step-by-step recording flow, and why there are two differently-locked
  ways to read a `ProblemProgress` row.

## Test status

- `PointsCalculatorTest` — 8/8 (no Testcontainers, <1s)
- `ProblemProgressIntegrationTest` — 5/5
- `ProblemProgressConcurrencyTest` — 2/2, each verified to actually fail
  when the underlying lock is removed (not just assumed to pass for the
  right reason)
- Re-verified unaffected: `AuthFlowIntegrationTest` (5/5, after the
  `AccessDeniedException` fix), `ScenarioCrudIntegrationTest` (6/6),
  `ScenarioSeedMigrationTest` (3/3), `AttemptFlowIntegrationTest` (7/7) —
  each individually, per `masterdoc/explain_testing.md`'s resource-contention note.
