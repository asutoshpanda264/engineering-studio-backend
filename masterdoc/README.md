# masterdoc — where to look for what

This repo holds two services, `api/` (Spring Boot) and `verify/`
(Node/Express) — see `architecture.md` for the split and why they're one
repo, not two.

## The global files (this folder)

| File | Answers |
|---|---|
| `architecture.md` | What exists, structurally — packages, the two-service split, build status per package |
| `flow.md` | What happens, in order, when a request comes in |
| `explanations.md` | Why the system is *shaped* this way, conceptually — the ideas that cut across every phase |
| `explain_<topic>.md` | The concrete "how" of one cross-cutting mechanic (currently: `explain_testing.md`) |
| `decisions.md` | Why one specific *project-wide* technical choice was made over an alternative (stack, Maven, Spring Boot version, dependencies, package layout) |

## Phase folders — one per milestone from the approved build plan

Each phase folder holds what's specific to that milestone only: its own
`README.md` (what shipped + test status), `decisions.md` (why its
phase-specific choices were made), one or more `explain_<topic>.md`
files (how its modules actually work), and `industry.md` (how real-world
systems solve the same problems this phase did, and how/why this
project's own approach compares — pros, cons, and trade-offs both ways).
Created when that phase's work starts, not pre-scaffolded ahead of time.

| # | Phase | Status | Folder |
|---|---|---|---|
| 1 | Auth & RBAC | ✅ done | `phase-1-auth-rbac/` |
| 2 | Scenario CRUD + publish workflow + 32-scenario migration | ✅ done | `phase-2-scenario-crud/` |
| 3 | Attempt state machine (verify stubbed) | ✅ done | `phase-3-attempt-state-machine/` |
| 4 | Node verify-service, real integration | ✅ done | `phase-4-verify-service-integration/` |
| 5 | Points + `PointsLedger` + upgrade-only `ProblemProgress` | ✅ done | `phase-5-points-and-progress/` |
| 6 | Redis leaderboards (3 ZSETs) | ✅ done | `phase-6-leaderboards/` |
| 7 | Daily challenge + streaks | ✅ done | `phase-7-daily-challenge-streaks/` |
| 8 | Caching + rate limiting | ✅ done | `phase-8-caching-and-rate-limiting/` |
| 9 | AI assistant seam (entities/endpoints only) | 🔲 not started (deferred — see below) | — |

Full scope of each numbered phase is in the approved build plan:
`/home/asutosh/.claude/plans/lets-dicuss-more-what-zany-swing.md`.

**Not one of the 9 numbered phases — a separate initiative, started once
Phase 8 gave the frontend something real to connect to:**

| Phase | Status | Folder |
|---|---|---|
| Frontend Integration — connecting `engineering_studio` (sibling repo) to this backend | ✅ Increments 1-6 done (auth foundation + Timed Challenge attempt/submit + leaderboard/daily-challenge pages + Workshop header signed-in indicator + NO_PRESSURE/free-play wiring + progress history page) — fully caught up to what the backend exposes | `phase-frontend-integration/` |

Milestone 9 is deliberately on hold until this is done.

## Quick "I want to know X" lookup

- *"What's actually built so far?"* → `architecture.md`'s package table, or
  this file's phase table above.
- *"How does login/JWT/RBAC work?"* → `phase-1-auth-rbac/explain_auth.md`.
- *"Why Spring Boot instead of Node?"* → `decisions.md` #1.
- *"Why did we skip `AuthenticationManager`?"* → `phase-1-auth-rbac/decisions.md` #5.
- *"How do the tests work, and when do I need Docker running?"* →
  `explain_testing.md`.
- *"A Spring Boot 4 import broke, how do I find where it moved?"* →
  `phase-1-auth-rbac/explain_boot4-migration.md`.
- *"How was this project even scaffolded without IntelliJ?"* →
  `decisions.md` #2's callout — curl'd Spring Initializr's own API directly
  (the same service IntelliJ's wizard calls), no IDE involved.
- *"How does scenario CRUD/publishing/versioning work?"* →
  `phase-2-scenario-crud/explain_scenario.md`.
- *"How did the 32 scenarios get from the frontend into Postgres?"* →
  `phase-2-scenario-crud/decisions.md` #9.
- *"How does start/pause/resume/submit and elapsed-time work?"* →
  `phase-3-attempt-state-machine/explain_attempt.md`.
- *"How do I test time-based logic without real sleeps?"* →
  `phase-3-attempt-state-machine/decisions.md` #2 (`MutableClock`).
- *"How does the verify-service actually score a submission?"* →
  `phase-4-verify-service-integration/explain_verify.md`.
- *"Why is this one repo instead of two?"* → `decisions.md` #7.
- *"What's `fakeNode` and why does `data.entityType` matter?"* →
  `phase-4-verify-service-integration/decisions.md` #2 — a real bug the
  fixture-parity test caught (cost silently computing as $0).
- *"How does the points formula work?"* →
  `phase-5-points-and-progress/explain_points.md`.
- *"How is the points-award race condition actually prevented?"* →
  `phase-5-points-and-progress/decisions.md` #2 and #3 — includes a real
  lesson about a timing-based concurrency test that passed for the wrong
  reason, and the deterministic test built to replace that false confidence.
- *"Why did `AuthFlowIntegrationTest` break during Phase 5?"* →
  `phase-5-points-and-progress/decisions.md` #5 (an `AccessDeniedException`
  regression in shared error-handling, caught by re-running an
  already-passing earlier phase's tests).
- *"How do the 3 Redis leaderboards actually update, and why doesn't NO_PRESSURE
  ever show up on one?"* → `phase-6-leaderboards/explain_leaderboard.md`.
- *"Why does the leaderboard update wait for AFTER_COMMIT instead of updating
  Redis immediately?"* → `phase-6-leaderboards/decisions.md` #3 — includes a
  real testing consequence (AFTER_COMMIT listeners never fire under the default
  rollback-wrapped test transaction) and the same class-level exception
  `ProblemProgressConcurrencyTest` (Phase 5) already established.
- *"Why is there no `testcontainers-redis` dependency?"* →
  `phase-6-leaderboards/decisions.md` #6 — no such module exists in this
  project's pinned Testcontainers BOM; Redis integration tests use a plain
  `GenericContainer` instead, verified against the actual jars, not guessed.
- *"Why did `ProblemProgressConcurrencyTest`'s cleanup change during Phase 6,
  when nothing about that test's own logic did?"* →
  `phase-6-leaderboards/decisions.md` #7, Finding B — the same
  re-run-earlier-phases'-tests practice that caught Phase 5's
  `AccessDeniedException` regression, catching a different kind of bug this
  time (a shared-resource side effect, not a shared-code regression).
- *"How does the daily challenge get picked, and why doesn't the 10pm
  admin-reminder feature exist yet?"* →
  `phase-7-daily-challenge-streaks/decisions.md` #1.
- *"Why does solving today's challenge in NO_PRESSURE mode keep my streak
  alive but never show up on a leaderboard?"* →
  `phase-7-daily-challenge-streaks/decisions.md` #3 and
  `explain_dailychallenge.md`'s last section — two separate, precisely-scoped
  domain events, confirmed as the intended product behavior.
- *"Why does `LeaderboardService` listen AFTER_COMMIT but `DailyChallengeService`
  doesn't?"* → `phase-7-daily-challenge-streaks/decisions.md` #4 — the
  mirror image of `phase-6-leaderboards/decisions.md` #3's reasoning:
  Redis needs it (not a JPA resource), Postgres-to-Postgres doesn't.
- *"What's the Hibernate first-level-cache gotcha with native `@Modifying`
  queries?"* → `phase-7-daily-challenge-streaks/decisions.md` #6 — a real
  bug caught on the first test run, with the `clearAutomatically = true`
  fix and why Phase 5's `ensureRowExists` never hit the same issue.
- *"How does scenario caching work, and how is it kept correct?"* →
  `phase-8-caching-and-rate-limiting/explain_caching_and_ratelimit.md`.
- *"Why did caching a `record` DTO throw `NotSerializableException`?"* →
  `phase-8-caching-and-rate-limiting/decisions.md` #11 — `RedisCacheManager`'s
  default value serializer needs `java.io.Serializable`; fixed with the
  Jackson-3.x `GenericJacksonJsonRedisSerializer`.
- *"How does rate limiting work, and why didn't it break every existing
  test the moment it shipped?"* →
  `phase-8-caching-and-rate-limiting/explain_caching_and_ratelimit.md`
  and `decisions.md` #10 — a new `application-test.yml` keeps the "test"
  Spring profile's limits effectively off; only `RateLimitIntegrationTest`
  turns them back down, via `@TestPropertySource`.
- *"Why does `AbstractIntegrationTest` clear every cache after each
  test?"* → `phase-8-caching-and-rate-limiting/decisions.md` #12 — the
  same cross-test Redis-leakage class of issue Phase 6/7 hit with their
  own explicit writes, this time from an ordinary cached read.
- *"Is the frontend actually connected to this backend yet? What changed
  on the frontend side?"* → `phase-frontend-integration/README.md` — the
  full file list on both sides, and `explain_frontend_integration.md` for
  how the two apps actually talk to each other.
- *"Why does signing in never gate anything a guest could already do?"* →
  `phase-frontend-integration/decisions.md` #1 — a deliberate, confirmed
  design choice (a signed-in session is additive, matching how LeetCode
  itself works), not an oversight.
- *"Where are the leaderboard and daily-challenge pages, and how does
  solving the daily challenge actually get credited?"* →
  `phase-frontend-integration/decisions.md` #13-16 and
  `explain_frontend_integration.md`'s Increment 3 section — no new
  attempt-flow wiring, just a deep-link into Increment 2's existing
  Timed Challenge path plus Phase 7's own event listener.
- *"Does free play (the default, untimed Workshop experience) create
  real backend attempts now?"* → `phase-frontend-integration/decisions.md`
  #18 and `explain_frontend_integration.md`'s Increment 5 section — yes,
  since Increment 5: a NO_PRESSURE attempt starts on scenario load,
  submits on the first passing run, and a fresh one opens immediately
  after so a later, better run can submit again.
- *"Why did a signed-in student's Timed Challenge (or free-play) attempt
  sometimes silently never reach the backend at all?"* →
  `phase-frontend-integration/decisions.md` #19 — a real race between
  `ScenarioDeepLink`'s mount effect and auth bootstrap's `/me` call,
  found during Increment 5's live testing and fixed there (affected both
  modes, not something Increment 5 introduced).
- *"Where can a student see every scenario they've ever solved, server-side —
  and why does a solved row sometimes show 0 points/stars?"* →
  `phase-frontend-integration/decisions.md` #21-23 — `/progress`
  (Increment 6), signed-in-only (no guest variant exists on the
  backend), and #22 specifically for why a NO_PRESSURE-only solve
  legitimately shows `—` rather than a broken-looking `0`.
- *"How does what we built here compare to how real companies/products
  solve the same problem?"* → every phase folder's own `industry.md`
  (all 9, including `phase-frontend-integration/`) — per-mechanism
  industry comparisons with named real systems, and the honest
  trade-offs of this project's simpler approach vs. theirs.
