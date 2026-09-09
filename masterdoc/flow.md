# flow.md — request lifecycle

What happens, in order, when a call reaches this service. For the static
structure (what packages exist), see `architecture.md`. For why each stage
is built the way it is, see `decisions.md`.

## The current request path (as of Phase 1 — auth/RBAC)

```
Client
  │  Authorization: Bearer <access token>  (omitted for public/anonymous reads)
  ▼
JwtAuthFilter            — verifies the JWT's signature, populates SecurityContext
  │                          (no-op if there's no token or it's invalid — request
  │                          just continues as anonymous)
  ▼
Spring Security filter chain (SecurityConfig)
  │  — coarse pass/fail: does this path require *any* authenticated user?
  ▼
Controller method
  │  — fine-grained: @PreAuthorize("hasRole('ADMIN')") etc., if present
  │  — @Valid on the request body triggers Bean Validation before the method body runs
  ▼
Service layer (business logic, @Transactional boundaries)
  ▼
Repository layer (Spring Data JPA) ──▶ Postgres
```

Errors from anywhere in that chain funnel through one place —
`GlobalExceptionHandler` — so every error response has the same JSON shape
(`ApiError`) regardless of what actually failed.

## The submit path (as of Phase 5 — points + progress)

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
  │                  ProblemProgress write + conditional PointsLedger insert —
  │                  see phase-5-points-and-progress/explain_points.md
  └── failure ──▶ AttemptFinalizer.markVerifyFailed(...)  (its own transaction,
                   touches only `status` — attempt stays resubmittable)
```

**Not yet part of this flow** (later phases): no Redis ZSET/leaderboard
update, no streak update — those packages don't exist yet. This section
gets extended again once Phase 6 (leaderboards) actually adds real side
effects to a
successful submit, not before.
