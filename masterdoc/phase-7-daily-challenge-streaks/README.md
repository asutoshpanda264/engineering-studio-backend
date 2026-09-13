# Phase 7 — Daily Challenge + Streaks

**Status:** ✅ done, verified against a real Postgres via Testcontainers.

## What shipped

A global "one scenario per calendar date" daily challenge
(`daily_challenges`), auto-assigned at random from PUBLISHED scenarios the
first time any date is needed and persisted from then on, with a real
`POST /admin/daily-challenge/{date}` override endpoint. Solving that day's
scenario — in either mode — records a `daily_challenge_completions` row
(idempotent per user per day) and updates the existing `User.currentStreak`
/`longestStreak`/`lastSolveDate` columns (reserved since Phase 1, actually
wired up now), all inside the same transaction as the `ProblemProgress`
write that triggered it. `GET /me` now returns the streak fields;
`GET /daily-challenge/today`, `/{date}`, `/today/me`, and `/history`
round out the read side.

NO_PRESSURE-mode solves of today's challenge keep the streak alive but
never touch the Phase 6 leaderboards — confirmed directly as the intended
product behavior (see decisions.md #3).

## Files in this repo

- `api/src/main/java/.../dailychallenge/` — `DailyChallenge`,
  `DailyChallengeAssignedBy`, `DailyChallengeRepository`,
  `DailyChallengeCompletion`, `DailyChallengeCompletionRepository`,
  `DailyChallengeService`, `DailyChallengeController`, `dto/`
- `api/src/main/java/.../admin/AdminDailyChallengeController.java`
- `api/src/main/java/.../progress/ScenarioSolvedEvent.java` (new);
  `ProblemProgressService` (publishes it) (edited)
- `api/src/main/java/.../auth/UserRepository.java` (`lockById`),
  `dto/UserResponse.java` (streak fields) (edited)
- `api/src/main/java/.../config/SecurityConfig.java` (the
  `/daily-challenge/today/me` + `/history` authenticated carve-out) (edited)
- `api/src/main/resources/db/migration/V5__daily_challenge.sql`
- `api/src/test/java/.../dailychallenge/DailyChallengeIntegrationTest.java`,
  `DailyChallengeConcurrencyTest.java`

## Docs in this folder

- `decisions.md` — 8 entries: what's actually built vs. deliberately
  deferred from the described admin-curation-plus-reminder design, why
  the AUTO pick is genuinely random rather than a deterministic
  hash-of-date, the two-separate-events design (and why Phase 6 stayed
  untouched), the plain-`@EventListener`-not-AFTER_COMMIT choice (the
  mirror image of Phase 6's reasoning) and its nice testability
  consequence, reusing Phase 5's exact idempotency-anchor-plus-lock
  pattern for streaks, a real Hibernate first-level-cache staleness bug
  actually caught while running the tests, the accepted caveat around
  admin-overriding an already-completed date, and why the streak fields
  landed on the existing `GET /me` instead of a new endpoint.
- `explain_dailychallenge.md` — the two tables, the get-or-auto-assign
  flow, the full write path from a submit to a streak actually updating
  (step by step, contrasted directly with Phase 6's), and why NO_PRESSURE
  affects one but not the other.
- `industry.md` — how real-world systems solve the same problems (daily-item
  assignment strategy vs. Wordle's deterministic pick, Duolingo/GitHub-style
  streak counting, idempotent completion recording, precise domain events,
  same-transaction vs. after-commit consistency, and the Hibernate
  identity-map staleness bug) and how this project's approach compares.

## Test status

- `DailyChallengeIntegrationTest` — 10/10, real Postgres via
  Testcontainers, extends `AbstractIntegrationTest` as-is (no
  transactional override needed — see decisions.md #4)
- `DailyChallengeConcurrencyTest` — 1/1, real threads, same
  `@Transactional(propagation = NOT_SUPPORTED)` exception
  `ProblemProgressConcurrencyTest` (Phase 5) established, reusing that
  phase's already-proven lock mechanism rather than re-proving it
- A real bug caught on the first actual run, not assumed away: a
  Hibernate first-level-cache staleness issue after a native `UPDATE` —
  see decisions.md #6 for the fix
- Re-verified unaffected, each individually per
  `masterdoc/explain_testing.md`: `AuthFlowIntegrationTest` (5/5 — the new
  `/daily-challenge/today/me`+`/history` SecurityConfig matchers didn't
  disturb the existing rules), `ProblemProgressIntegrationTest` (5/5),
  `ProblemProgressConcurrencyTest` (2/2), `AttemptFlowIntegrationTest`
  (7/7), `LeaderboardIntegrationTest` (6/6 — Phase 6 unaffected by the new
  `ScenarioSolvedEvent` publish sitting right next to its own
  `ProblemProgressUpgradedEvent`), `ScenarioCrudIntegrationTest` (6/6),
  `ScenarioSeedMigrationTest` (3/3 — failed once with `Connection refused`
  when run back-to-back with another Testcontainers class after ~8
  consecutive test-JVM launches in one session, exactly the documented
  resource-pressure pattern in `explain_testing.md`; passed cleanly
  re-run alone once memory recovered — not a code regression),
  `PointsCalculatorTest` (8/8), `LeaderboardTypeTest` (3/3).
