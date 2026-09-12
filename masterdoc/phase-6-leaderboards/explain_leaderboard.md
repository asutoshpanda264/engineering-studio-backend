# explain_leaderboard.md — how the 3 Redis leaderboards actually work

## The three boards

All three are Redis ZSETs, member = `userId.toString()`, keyed
`leaderboard:most-solved` / `leaderboard:best-solved` /
`leaderboard:fastest-solved` (`LeaderboardType.redisKey()`). Score
direction is uniformly **higher = better** on all three:

| Board | Score | Source |
|---|---|---|
| most-solved | count of leaderboard-eligible scenarios solved | `COUNT(*)` over `problem_progress` |
| best-solved | sum of `best_points` across those scenarios | `SUM(best_points)` |
| fastest-solved | average `best_speed_factor` across those scenarios | `AVG(best_speed_factor)` |

"Leaderboard-eligible" means `best_speed_factor IS NOT NULL` — see
decisions.md #5 for why that one column is exactly the right filter
(it's only ever set on a genuine TIMED-mode points upgrade, which is the
same thing `attempt.AttemptMode`'s Javadoc calls the only kind of solve
that belongs on a leaderboard at all).

## The write path — from a submit to Redis actually changing

```
POST /attempts/{id}/submit
  → AttemptService.submit (not @Transactional)
    → verify-service call (HTTP, outside any transaction)
    → AttemptFinalizer.finalizeVerified (@Transactional — opens the transaction)
        → Attempt.status = SUBMITTED
        → ProblemProgressService.recordOutcome (same transaction)
            → best_points/best_speed_factor upgraded (delta > 0, TIMED only)
            → PointsLedgerEntry saved
            → eventPublisher.publishEvent(ProblemProgressUpgradedEvent(userId))
    ← finalizeVerified's transaction COMMITS ←──────────────┐
                                                              │
  LeaderboardService.onProgressUpgraded fires HERE, synchronously,
  still inside the submit() call, because it's @TransactionalEventListener
  (phase = AFTER_COMMIT) — Spring runs AFTER_COMMIT synchronizations
  immediately after the physical commit, on the same thread that committed.
    → LeaderboardService.refreshUser(userId)
        → ProblemProgressRepository.aggregateLeaderboardStats(userId)
          (a fresh, separate, self-transactional read — Spring Data JPA
          wraps every repository query method in its own transaction if
          none is already open; the transaction that produced the upgrade
          is already closed by this point)
        → ZADD leaderboard:most-solved    <userId> <solvedCount>
        → ZADD leaderboard:best-solved    <userId> <totalPoints>
        → ZADD leaderboard:fastest-solved <userId> <avgSpeedFactor>
  ← submit()'s HTTP response returns, only now
```

Nothing here is asynchronous or eventually-consistent — by the time a
`POST /attempts/{id}/submit` call returns 200, Redis already reflects the
new state. The only asynchrony is the ordering guarantee itself: Redis is
never touched until Postgres has durably committed first (decisions.md
#3).

## Why "recompute this user's totals from scratch" instead of applying a delta

Every `refreshUser(userId)` call re-reads the user's current aggregate
stats from Postgres and `ZADD`s (overwrites, not increments) all three
boards to match. This means the Redis write is **idempotent** — running
`refreshUser` for the same user twice in a row, or after a long delay,
lands on exactly the same numbers, because those numbers are always
derived from whatever Postgres says *right now*, never from what Redis
previously held. There's no delta to get wrong, no "did I already apply
this event" bookkeeping needed. See decisions.md #1 for the full
reasoning, and #6 for `rebuildAll()` — the same operation, just run for
every eligible user instead of one.

## Reading a board

`GET /leaderboards/{type}` — `ZREVRANGE ... WITHSCORES` for the top
`limit` members (default 20, max 100), then one batched
`UserRepository.findAllById` to attach display names, since Redis only
ever stores the raw `userId`.

`GET /leaderboards/{type}/me` — `ZREVRANK` + `ZSCORE` for the calling
user. `ranked: false` (not a 404) is the normal, expected shape for
someone who hasn't earned a leaderboard-eligible solve yet — it's not an
error state.

Both are public reads except `/me` (self-only, needs to know who's
calling) — `SecurityConfig` already reserved the whole `/leaderboards/**`
path as a public GET back in Phase 1, before this package existed; this
phase only had to carve `/leaderboards/*/me` back out as
authenticated-only, the exact same `permitAll`-plus-`@PreAuthorize`-override
shape already used for `GET /scenarios/drafts`.

## Rebuilding from scratch

`POST /admin/leaderboard/rebuild` (ADMIN-only) calls
`LeaderboardService.rebuildAll()`, which finds every userId with at least
one eligible `problem_progress` row and calls `refreshUser` for each.
This isn't a hypothetical safety net — `LeaderboardIntegrationTest`
actually wipes Redis and proves this one call regenerates identical
state. It's the practical proof of decisions.md #1's central claim: Redis
here is disposable, not authoritative.
