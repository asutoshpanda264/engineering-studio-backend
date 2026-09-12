# explain_dailychallenge.md — how the daily challenge + streaks actually work

## The two tables

```
daily_challenges              -- one global row per calendar date
  challenge_date  DATE PRIMARY KEY
  scenario_id     -> scenarios(id)
  assigned_by     AUTO | ADMIN

daily_challenge_completions   -- one row per (user, date) at most
  user_id, challenge_date     UNIQUE together
  scenario_id, attempt_id, mode, completed_at
```

`daily_challenges` has no surrogate id — the date itself is already a
natural, globally-unique key, and one global challenge per day (not per
user) is the whole point of a "daily challenge." `User.currentStreak` /
`longestStreak` / `lastSolveDate` (columns since Phase 1) are the actual
mutable streak state; `daily_challenge_completions` is the append-only
audit trail behind them, same shape as `points_ledger` (Phase 5).

## Getting a date's challenge — auto-assign, get-or-create

```
DailyChallengeService.getOrAutoAssign(date):
  findById(date)
    found  -> return it
    absent -> pick a random PUBLISHED scenario
              tryAutoAssign(date, scenarioId)   -- INSERT ... ON CONFLICT DO NOTHING
              findById(date)                    -- re-read: a concurrent
                                                    caller might have won
                                                    the race with a
                                                    DIFFERENT random pick
              -> return whichever one actually landed
```

`GET /daily-challenge/today` and `GET /daily-challenge/{date}` (any date
up to and including today — a future date 404s, so nobody can URL-guess
tomorrow's pick) both go through this. It's also called from the solve
listener below, so a user solving today's designated scenario before
ANYONE has ever loaded `/daily-challenge/today` still gets exactly the
same deterministic-once-persisted assignment.

## Admin override

`POST /admin/daily-challenge/{date}` (ADMIN-only) calls
`DailyChallengeRepository.adminAssign` — a real upsert
(`ON CONFLICT (challenge_date) DO UPDATE`), so it works whether that date
already has an AUTO pick or not. See decisions.md #1 for what this
endpoint is (and isn't) part of, and #7 for the known caveat about
overriding a date that already has completions.

## The write path — from a submit to a streak actually updating

```
POST /attempts/{id}/submit
  → AttemptFinalizer.finalizeVerified (@Transactional)
      → ProblemProgressService.recordOutcome (same transaction)
          → gatesPassed == true
              → eventPublisher.publishEvent(ScenarioSolvedEvent(userId, scenarioId, attemptId, mode, solvedOn))
                  (solvedOn = LocalDate.now(clock) — the SAME clock this
                  service already uses for everything else time-related)
              → (mode/upgrade branching continues independently — this
                 event fires regardless of what happens next)

  DailyChallengeService.onScenarioSolved fires HERE — a plain
  @EventListener, so it runs synchronously, INLINE, still inside
  recordOutcome's own open transaction (contrast: Phase 6's
  LeaderboardService listens AFTER_COMMIT instead — see decisions.md #4
  for exactly why the two phases made opposite choices)
    → getOrAutoAssign(event.solvedOn())        -- today's designated scenario
    → scenarioId != today's scenario?  -> return, nothing to do
    → tryRecordCompletion(...)                  -- INSERT ... ON CONFLICT
                                                    (user_id, challenge_date)
                                                    DO NOTHING
    → returned 0 rows (already completed today)? -> return, streak untouched
    → returned 1 row (first completion today):
        → UserRepository.lockById(userId)        -- @Lock(PESSIMISTIC_WRITE),
                                                      same mechanism as
                                                      ProblemProgress's own
                                                      Phase-5 locked read
        → yesterday == lastSolveDate?  currentStreak += 1
        → else                          currentStreak = 1
        → longestStreak = max(longestStreak, currentStreak)
        → lastSolveDate = solvedOn

  ← recordOutcome's transaction COMMITS — completion row AND streak
    update commit together with the ProblemProgress write, atomically,
    or none of them do
```

Because this is all one transaction, `DailyChallengeIntegrationTest`
needed none of `LeaderboardIntegrationTest`'s
`@Transactional(propagation = NOT_SUPPORTED)` ceremony — every write
above rolls back cleanly at the end of each test method, the same as
`ProblemProgressIntegrationTest`.

## Why NO_PRESSURE keeps a streak alive but never touches the leaderboard

Two different events, on purpose:

- `ScenarioSolvedEvent` — published whenever `gatesPassed` is true, ANY
  mode. `DailyChallengeService` listens to this.
- `ProblemProgressUpgradedEvent` (Phase 6) — published only on a genuine
  TIMED, `delta > 0` upgrade. `LeaderboardService` listens to this,
  unchanged since Phase 6.

Confirmed directly with the product owner: a streak is about daily
engagement (solving today's puzzle at all, any mode), while leaderboard
eligibility stays deliberately narrower (a real, timed result) — see
decisions.md #3.

## Reading a user's streak

Not a dedicated endpoint — `GET /me` (Phase 1's own endpoint,
`UserResponse`) now returns `currentStreak`/`longestStreak`/`lastSolveDate`
directly, since those columns and that endpoint have both existed since
Phase 1 for exactly this. `GET /daily-challenge/today/me` only answers
"did I complete today's" (a boolean); `GET /daily-challenge/history`
lists every completion, newest first, for a calendar/heatmap-style view.
