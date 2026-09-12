# flow.md — request lifecycle

What happens, in order, when a call reaches this service. For the static
structure (what packages exist), see `architecture.md`. For why each stage
is built the way it is, see `decisions.md`.

## The current request path (as of Phase 8 — + rate limiting)

```
Client
  │  Authorization: Bearer <access token>  (omitted for public/anonymous reads)
  ▼
JwtAuthFilter            — verifies the JWT's signature, populates SecurityContext
  │                          (no-op if there's no token or it's invalid — request
  │                          just continues as anonymous)
  ▼
RateLimitFilter (Phase 8) — ONLY for POST /auth/login, /auth/register (per IP)
  │                          and POST /attempts/{id}/submit (per authenticated
  │                          user); every other path passes straight through.
  │                          Over the limit → 429 here, chain stops — Spring
  │                          Security's own authorization decision below never
  │                          runs, neither does the controller. See
  │                          phase-8-caching-and-rate-limiting/explain_caching_and_ratelimit.md
  ▼
Spring Security filter chain (SecurityConfig)
  │  — coarse pass/fail: does this path require *any* authenticated user?
  ▼
Controller method
  │  — fine-grained: @PreAuthorize("hasRole('ADMIN')") etc., if present
  │  — @Valid on the request body triggers Bean Validation before the method body runs
  ▼
Service layer (business logic, @Transactional boundaries)
  │  — GET /scenarios and GET /scenarios/{id} (Phase 8): @Cacheable checks
  │    Redis first — a hit returns here, never reaching the repository/Postgres
  │    below. A miss falls through normally and populates the cache on the way
  │    back out.
  ▼
Repository layer (Spring Data JPA) ──▶ Postgres
```

Errors from anywhere in that chain funnel through one place —
`GlobalExceptionHandler` — so every error response has the same JSON shape
(`ApiError`) regardless of what actually failed.

## The submit path (as of Phase 7 — + daily challenge/streaks)

`POST /attempts/{id}/submit` doesn't fit the generic request path above —
it deliberately has NO surrounding `@Transactional` at the service-method
level, because a mid-flight call to `verify/` (a real HTTP call across
processes as of Phase 4, genuinely able to time out or fail) has to be
allowed to fail without rolling back the failure-status write that needs to
survive it. Full mechanics (and why) in
`phase-3-attempt-state-machine/explain_attempt.md`, `decisions.md` #3, and
`phase-4-verify-service-integration/` for the real HTTP leg:

```
POST /attempts/{id}/submit           (api/, Spring Boot)
  ▼
AttemptService.submit — NOT @Transactional
  │  computes elapsed/paused time in memory (server timestamps only, no write yet)
  │  fetches the exact scenario body this attempt was solved against via
  │  ScenarioService.getVersion(...) — see scenario/decisions.md #5
  ▼
HttpVerifyClient.verify(...) ──HTTP──▶ POST /verify   (verify/, Node — a
  │  unguarded by any transaction        separate process/service)
  │  10s timeout, no retry
  ├── success ──▶ AttemptFinalizer.finalizeVerified(...)  (its own transaction,
  │                a separate bean — see decisions.md #3 on why it can't just
  │                be another @Transactional method on AttemptService itself)
  │                  │
  │                  ▼
  │                ProblemProgressService.recordOutcome(...) — SAME transaction
  │                  (Phase 5) ensureRowExists -> SELECT...FOR UPDATE -> upgrade-only
  │                  ProblemProgress write
  │                  (Phase 7) gatesPassed == true (ANY mode):
  │                  eventPublisher.publishEvent(ScenarioSolvedEvent) — a plain
  │                  @EventListener, so DailyChallengeService.onScenarioSolved
  │                  fires SYNCHRONOUSLY, INLINE, right here, still inside
  │                  this same open transaction (contrast the AFTER_COMMIT
  │                  listener below — see phase-7's decisions.md #4 for why
  │                  these two listeners chose opposite phases)
  │                    │
  │                    ▼
  │                  DailyChallengeService.onScenarioSolved
  │                    → getOrAutoAssign(today) → is this scenario today's
  │                      designated challenge? if not, no-op
  │                    → tryRecordCompletion (INSERT ... ON CONFLICT
  │                      (user_id, challenge_date) DO NOTHING) — already
  │                      completed today? no-op
  │                    → else: lockById(userId), update currentStreak/
  │                      longestStreak/lastSolveDate — see
  │                      phase-7-daily-challenge-streaks/explain_dailychallenge.md
  │                  conditional PointsLedger insert + (Phase 6) on a genuine
  │                  upgrade (delta > 0, TIMED only):
  │                  eventPublisher.publishEvent(ProblemProgressUpgradedEvent) —
  │                  queued, not yet acted on; nothing outside Postgres has
  │                  happened at this point
  │                  │
  │                  ▼  (this transaction COMMITS — finalizeVerified returns,
  │                  now carrying the daily-challenge/streak writes above
  │                  too, atomically with everything else in it)
  │                LeaderboardService.onProgressUpgraded — @TransactionalEventListener
  │                  (phase = AFTER_COMMIT), fires HERE, synchronously, still
  │                  inside the same submit() call
  │                  │
  │                  ▼
  │                LeaderboardService.refreshUser(userId) ──▶ Redis
  │                  re-reads this user's totals from Postgres (a fresh,
  │                  self-transactional read), ZADDs all 3 leaderboard ZSETs
  │                  to match — see phase-6-leaderboards/explain_leaderboard.md
  └── failure ──▶ AttemptFinalizer.markVerifyFailed(...)  (its own transaction,
                   touches only `status` — attempt stays resubmittable; no
                   event published, nothing for Phase 6 or 7 to react to)
```

**Not yet part of this flow** (Phase 9): the AI assistant seam. Also
still deferred from the daily-challenge design itself: a scheduled
reminder notification to an admin "challenge setter" if a future date is
still unset — see `phase-7-daily-challenge-streaks/decisions.md` #1.
