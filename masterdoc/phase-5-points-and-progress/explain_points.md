# explain_points.md — the `points` and `progress` packages

How the formula and the upgrade-only recording actually work. For *why*
each choice was made, see this folder's `decisions.md`.

## The formula, spelled out

```
basePoints      = difficulty(1-5) × 20
starsMultiplier = 0★→0, 1★→0.5, 2★→0.75, 3★→1.0, 5★("legendary")→1.5   (4★ doesn't exist)
timeRatio       = elapsedSeconds / timeLimitSeconds, clamped to [0, 1]
difficultyW     = difficulty / 5
speedFactor     = 1 + difficultyW × (0.5 − timeRatio) × 0.6
finalPoints     = round(basePoints × starsMultiplier × speedFactor)
```

Intuition: `speedFactor` is 1.0 exactly at `timeRatio = 0.5` (used half the
time limit) — faster than that is a bonus, slower is a penalty, and the
size of that swing scales with difficulty (`difficultyW`). A hard scenario
solved fast earns a real bonus; an easy scenario solved slowly only loses a
little, since its `basePoints` was already small. `timeLimitSeconds` comes
from the scenario's own `suggestedTimeLimitMinutes` if set, otherwise
`PointsCalculator.defaultTimeLimitSeconds(difficulty)` — the same
per-difficulty default (10/15/20/25/30 minutes) the frontend's own
`timedChallenge.ts` uses, so a scenario without an explicit limit still
gets a countdown that matches what a student would actually see.

`NO_PRESSURE`-mode attempts never reach this formula at all — see below.

## What happens on every submit that passes the scenario's gates

```
1. ensureRowExists(userId, scenarioId)   — idempotent, race-safe upsert-insert
2. lockByUserIdAndScenarioId(...)        — SELECT ... FOR UPDATE, blocks a
                                            concurrent submit for the same
                                            (user, scenario) until this
                                            transaction commits
3. status -> SOLVED (first_solved_at set, but ONLY the first time ever)
4. if mode == NO_PRESSURE:
     save (SOLVED, zero points, no ledger entry) — done
5. candidatePoints = PointsCalculator.totalPoints(difficulty, stars, elapsedSeconds, timeLimit)
6. delta = max(0, candidatePoints - progress.bestPoints)
7. if delta > 0:
     upgrade best_stars / best_points / best_composite / best_speed_factor / solved_attempt_id
     insert a PointsLedgerEntry(deltaPoints = delta, runningTotalForScenario = candidatePoints)
   else:
     no upgrade, no ledger entry — a re-solve at equal-or-worse quality earns nothing
```

A submit that *fails* the gates never reaches step 3 onward — the row
still gets its `last_attempt_at` touched (so "when did I last try this"
stays accurate) but stays `ATTEMPTED`, never `SOLVED`, and a scenario
already `SOLVED` never gets demoted back by a later bad attempt.

## Why locking happens on *every* qualifying submit, not just contested ones

`ensureRowExists` + `lockByUserIdAndScenarioId` run unconditionally, even
when nobody else is submitting at the same moment — there's no cheap way
to know in advance whether a race is actually happening, and the lock is
only held for the duration of one short transaction, so the cost of always
taking it is negligible compared to the cost of getting it wrong once.

## Two different node shapes, two different repository methods — don't confuse them

`ProblemProgressRepository` has two ways to fetch a `(user, scenario)`
row, and using the wrong one in the wrong place is exactly the kind of bug
that wouldn't show up until real concurrent traffic hit it:

- `findByUserIdAndScenarioId` — a plain read, no lock. Used by
  `GET /progress/scenarios/{id}` — rendering a user's own progress page
  should never contend with a concurrent submit for no reason, and a
  pessimistic lock needs an active transaction to hold it, which a plain
  read endpoint has no other reason to open.
- `lockByUserIdAndScenarioId` — `SELECT ... FOR UPDATE`. Used *only* inside
  `ProblemProgressService.recordOutcome`, the one place a read-modify-write
  actually needs the guarantee.

## Testing

`PointsCalculatorTest` — pure, no Spring context, every star tier and
speed-factor edge case, sub-second. `ProblemProgressIntegrationTest` — the
non-concurrent behavior (solving awards the right points, a worse
re-attempt never downgrades, `NO_PRESSURE` marks solved with zero points,
a failed gate stays `ATTEMPTED`). `ProblemProgressConcurrencyTest` — the
two-part concurrency proof described in `decisions.md` #3: an end-to-end
race scenario plus a direct, deterministic test of the locking mechanism
itself, verified in both directions (fails without the lock, passes with
it) rather than assumed to work from the code alone.
