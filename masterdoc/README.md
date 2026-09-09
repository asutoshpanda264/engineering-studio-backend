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
phase-specific choices were made), and one or more `explain_<topic>.md`
files (how its modules actually work). Created when that phase's work
starts, not pre-scaffolded ahead of time.

| # | Phase | Status | Folder |
|---|---|---|---|
| 1 | Auth & RBAC | ✅ done | `phase-1-auth-rbac/` |
| 2 | Scenario CRUD + publish workflow + 32-scenario migration | ✅ done | `phase-2-scenario-crud/` |
| 3 | Attempt state machine (verify stubbed) | ✅ done | `phase-3-attempt-state-machine/` |
| 4 | Node verify-service, real integration | ✅ done | `phase-4-verify-service-integration/` |
| 5 | Points + `PointsLedger` + upgrade-only `ProblemProgress` | ✅ done | `phase-5-points-and-progress/` |
| 6 | Redis leaderboards (3 ZSETs) | 🔲 not started | — |
| 7 | Daily challenge + streaks | 🔲 not started | — |
| 8 | Caching + rate limiting | 🔲 not started | — |
| 9 | AI assistant seam (entities/endpoints only) | 🔲 not started | — |

Full scope of each phase is in the approved build plan:
`/home/asutosh/.claude/plans/lets-dicuss-more-what-zany-swing.md`.

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
