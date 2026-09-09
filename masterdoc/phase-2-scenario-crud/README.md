# Phase 2 — Scenario CRUD + Publish Workflow + 32-Scenario Migration

**Status:** ✅ done, verified against a real Postgres via Testcontainers.

## What shipped

Full scenario lifecycle: contributor/admin create (draft) → admin publish →
optional archive, plus admin-only hard-delete of drafts. Every edit bumps
the scenario's version and snapshots the previous one, so a historical
version stays fetchable forever. The 32 existing Workshop scenarios
(`engineering_studio/src/scenarios/index.ts`) migrated into Postgres as the
seed data, replacing the frontend's static import as source of truth for
this content type.

Also landed as part of this phase: a `CurrentUser` auth helper (userId+role
extraction, reused from `auth`), an explicit 401 vs 403 distinction in
`SecurityConfig`, and `@Transactional` test isolation for the whole
integration test suite (see `decisions.md` #7/#8 — both found via real test
failures, not planned upfront).

## Files in this repo

- `api/src/main/java/.../scenario/` — `Scenario`, `ScenarioVersion`,
  `ScenarioStatus`, `ScenarioMapper`, `ScenarioService`, `ScenarioController`,
  repositories, DTOs
- `api/src/main/java/.../common/json/JsonUtil.java`
- `api/src/main/java/.../auth/CurrentUser.java`
- `api/src/main/resources/db/migration/V2__scenario.sql`,
  `V2.1__seed_scenarios.sql`
- `tools/migrate-scenarios/generate-seed-sql.js` — regenerate the seed
  migration if the frontend's scenario data changes before this project's
  own CRUD becomes the only source of truth for it
- `api/src/test/java/.../scenario/ScenarioCrudIntegrationTest.java`,
  `ScenarioSeedMigrationTest.java`

## Docs in this folder

- `decisions.md` — 9 entries: JSONB persistence strategy, the Jackson
  version choice (again — a second, deliberate encounter with the Phase 1
  finding), ownership/RBAC rules, versioning semantics, the routing
  correction, the 401 entry point fix, test isolation, and the full
  32-scenario migration story including a real Flyway/JSON collision bug.
- `explain_scenario.md` — the state machine, versioning mechanics, JSONB
  boundary, and how the seed migration works.

## Test status

Verified individually (not as one combined run — see
`masterdoc/explain_testing.md`'s note on this machine's resource
constraints while another project's Docker stack runs concurrently):
- `ScenarioCrudIntegrationTest` — 6/6
- `ScenarioSeedMigrationTest` — 3/3
- `AuthFlowIntegrationTest` (Phase 1, re-verified unaffected) — 5/5
- `EngineeringStudioApiApplicationTests` — 1/1

15/15 total, each class independently green.
