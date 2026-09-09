# architecture.md — what exists and how it's structured

The structural picture: what this repo is, the two-service split, and
what's built vs. not yet. For the request-by-request *process* (what happens
when a call comes in), see `flow.md`. For the reasoning behind any of this,
see `decisions.md` (global) or a phase folder's own `decisions.md`.

## What this repo is

The backend for Engineering Studio (a distributed-systems learning sandbox —
see the frontend repo at `../engineering_studio`, a sibling directory, not
part of this repo). The frontend is, and stays, a static Next.js app with no
backend of its own; this repo is the new system of record for everything
that needs to persist across sessions or be trusted (who's who, what's been
solved, who's ranked where).

Two services, one repo (`decisions.md` #7 — started as two separate repos,
deliberately combined once it was clear that cost nothing real for a
solo-developer project):

```
engineering-studio-backend/
  api/       Spring Boot — users, roles, scenarios, attempts, points,
             progress, leaderboards, daily challenges
  verify/    Node/Express — re-runs the frontend's own simulation engine
             server-side, so a submitted architecture's score is computed
             by the server, never trusted from the client (see
             explanations.md's "never trust the client" principle)
  masterdoc/ this — spans both services
```

`api/` calls `verify/` over plain HTTP (`HttpVerifyClient` → `POST /verify`)
— they're still two independently deployable services (each gets its own
process, its own port, its own deploy target), just versioned and documented
together. See `phase-4-verify-service-integration/` for how they were built
and how they talk to each other.

## `api/` package map (grows as phases land)

| Package | Owns | Status |
|---|---|---|
| `auth` | Users, roles, login/register/refresh/logout, JWT issuance+validation | ✅ built — `phase-1-auth-rbac/explain_auth.md` |
| `config` | Cross-cutting beans: security filter chain, JWT properties, `Clock`, `PasswordEncoder` | ✅ built |
| `common.error` | The one exception type (`ApiException`) and the one error response shape (`ApiError`) used everywhere | ✅ built |
| `admin` | Currently just the RBAC smoke-test endpoint (`/admin/ping`); real user/role-management endpoints land later | 🚧 placeholder only |
| `scenario` | Scenario CRUD, draft→publish workflow, versioning, the 32-scenario seed | ✅ built — `phase-2-scenario-crud/explain_scenario.md` |
| `common.json` | `JsonUtil` — the one place JSON-string-in-the-database meets typed-object-in-Java | ✅ built |
| `attempt` | The start/pause/resume/submit state machine, server-authoritative elapsed time, calls `verify/` over real HTTP | ✅ built — `phase-3-attempt-state-machine/explain_attempt.md` (state machine), `phase-4-verify-service-integration/` (the real verify call) |
| `points` | The points formula (pure, unit-tested), `PointsLedger` | ✅ built — `phase-5-points-and-progress/explain_points.md` |
| `progress` | Per-user per-scenario `ProblemProgress` (upgrade-only, concurrency-safe); plain completion-tracking for lessons/LLD/interview-Qs still deferred | ✅ built (scenario progress) — `phase-5-points-and-progress/explain_points.md` |
| `leaderboard` | The 3 Redis-ZSET-backed leaderboards | 🔲 not yet built |
| `dailychallenge` | Daily challenge calendar + streaks | 🔲 not yet built |
| `ai` | Seam only for a future AI design-review assistant — entities/endpoints, no logic | 🔲 not yet built |

Full detail on what each package will do (points formula, leaderboard
definitions, the attempt state machine, etc.) is in the approved build plan
at `/home/asutosh/.claude/plans/lets-dicuss-more-what-zany-swing.md`. This
table gets a status update, and a new `masterdoc/phase-N-<slug>/` folder,
as each one actually lands — not written ahead of the code.

## `verify/` structure

Deliberately thin — one real job (score a submitted graph), not
package-by-feature like `api/` (there's only one feature):

```
verify/
  sync-vendor.sh        copies specific files from ../../engineering_studio
                         into vendor/src/ — see decisions.md #9 in
                         phase-4-verify-service-integration/
  vendor/src/            the copied frontend engine code, committed as-is
  src/
    graphAdapter.ts       client graph JSON -> the two node shapes the
                           vendored functions expect
    verify.ts             orchestrates: runSimulation -> scoreScenario
    server.ts              Express, POST /verify + GET /health
  test/
    verify.fixtureParity.test.ts   the single most important test in this
                                    repo — see phase-4-verify-service-integration/
```

## Phase index

See `masterdoc/README.md` for the full phase-by-phase table (all 9 planned
phases, matching the approved build plan's milestones) and what's in each
phase folder once it exists.
