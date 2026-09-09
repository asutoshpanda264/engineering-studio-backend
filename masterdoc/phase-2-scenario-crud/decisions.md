# decisions.md — Phase 2: Scenario CRUD + Publish Workflow + 32-Scenario Migration

Decisions specific to the `scenario` package and the seed migration.
Project-wide decisions live in `masterdoc/decisions.md`.

---

## 1. JSONB columns mapped as raw `String`, converted explicitly — not Hibernate's automatic object↔JSON marshalling

- **Chose:** every JSONB column on `Scenario`/`ScenarioVersion` is a plain
  `String` field (`@JdbcTypeCode(SqlTypes.JSON)`, raw JSON text in, raw JSON
  text out). All conversion to/from typed Java objects happens explicitly in
  `ScenarioMapper`, via a small `JsonUtil` helper.
- **Considered:** Hibernate 6/7's native support for mapping a JSONB column
  directly to a typed Java field (a `List<String>`, a custom record, etc.),
  letting Hibernate's own internal Jackson integration handle the
  conversion automatically.
- **Why this instead:** this project's classpath already carries two
  unrelated Jackson major versions for unrelated reasons (Spring's
  auto-configured Jackson 3.x for HTTP; `jjwt-jackson`'s classic Jackson 2.x
  for JWT signing, at *runtime* scope only — see
  `phase-1-auth-rbac/explain_boot4-migration.md`). Which one Hibernate's
  internal `FormatMapper` would pick, given both are present, isn't
  something worth betting application code on without deep verification —
  explicit conversion through one deliberately-chosen library (see #2)
  keeps this fully under control and easy to explain, rather than relying
  on framework auto-detection behavior across two competing dependencies.
- **Scenario it covers:** avoids a repeat of the exact class of surprise
  Phase 1 already hit once (`explain_boot4-migration.md`) — here, in a new
  place (persistence) rather than testing.

## 2. `JsonUtil` uses Jackson 3.x (`tools.jackson`), not classic Jackson 2.x

- **Chose:** `tools.jackson.databind.json.JsonMapper` + `tools.jackson.core.type.TypeReference`.
- **Considered:** classic `com.fasterxml.jackson.databind.ObjectMapper`
  (used successfully in Phase 1's test code).
- **Why this instead:** discovered while first writing this class — classic
  Jackson 2.x compiled fine in a first draft, then failed at `mvn compile`
  specifically, with `package com.fasterxml.jackson.databind does not
  exist`. Root cause: it's only ever a **runtime**-scope transitive
  dependency here (via `jjwt-jackson`), visible to *test* code (whose
  classpath includes main's runtime deps) but never to *main* source at
  compile time. Rather than adding a redundant Jackson 2.x compile
  dependency just to keep the code looking familiar, switched to Jackson
  3.x — which is already a genuine compile-scope dependency
  (`spring-boot-starter-jackson`) and is the same line Spring's own HTTP
  serialization uses. Confirmed its API by inspecting the actual jars
  directly (`javap`) rather than assuming 2.x-familiar method signatures
  still apply — `ObjectMapper`/`JsonMapper` both have working public
  constructors, and `JacksonException` is unchecked in 3.x (extends
  `RuntimeException`), unlike 2.x's checked `JsonProcessingException`.
- **Scenario it covers:** this is the second time this exact
  runtime-vs-compile-scope trap has mattered (see #1) — worth remembering
  as a general instinct on this project: before using ANY library that
  arrived on the classpath transitively, check whether it's actually a
  *compile*-scope dependency of the code doing the importing, not just
  "present somewhere on the classpath."

## 3. `scenario_versions` uses a surrogate UUID primary key, not the plan's composite `(scenario_id, version)`

- **Chose:** `id UUID PRIMARY KEY` + a `UNIQUE (scenario_id, version)`
  constraint.
- **Considered:** the composite primary key the original plan doc sketched.
- **Why this instead:** nothing else in the schema needs to reference one
  specific version row by that composite key (an `Attempt`, in a later
  phase, references a scenario by `id` + `scenarioVersion` as two plain
  columns, not a foreign key into this table) — so a composite PK buys
  nothing here while costing real JPA ceremony (`@EmbeddedId` or
  `@IdClass`). A surrogate id is simpler and the `UNIQUE` constraint still
  enforces the exact same invariant (never two rows for the same
  scenario+version).
- **Scenario it covers:** N/A — implementation simplification, not a
  behavioral difference from what was planned.

## 4. Ownership/edit rules: contributor can edit only their OWN scenario, and only while it's still DRAFT; admin can edit any, any status

- **Chose:** `ScenarioService.assertCanEdit` — `ADMIN` always passes;
  `CONTRIBUTOR` must be both the scenario's `createdBy` AND the scenario
  must still be `DRAFT`, or it's a 403.
- **Considered:** letting a contributor keep editing their own scenario
  even after it's published.
- **Why this instead:** once published, a scenario is live — real users may
  already be attempting it. Letting the original author silently alter a
  live problem (even their own) without admin oversight undermines the
  whole "admin approval required before publishing" workflow the product
  decision already established; the approval gate would be meaningless if
  edits after that gate needed no further review. Admin retains edit access
  regardless of status specifically so a live scenario can still be fixed
  (a typo, a miscalibrated constraint) without a full unpublish/republish
  cycle.
- **Scenario it covers:** a contributor's compromised or malicious account
  altering a scenario's constraints/optimal solution after publication to
  game leaderboard difficulty, or just an honest mistake reaching
  production without a second set of eyes.

## 5. `GET /scenarios/{id}/versions/{version}` falls back to the live row for the CURRENT version

- **Chose:** `ScenarioService.getVersion` checks `version ==
  scenario.getVersion()` first and returns the live row's content directly
  if so; only queries `scenario_versions` for anything older.
- **Considered:** always snapshotting on publish/every read, so every
  version including the current one always has a `scenario_versions` row.
- **Why this instead:** `scenario_versions` is written exactly once per
  edit (right before the edit is applied — see `ScenarioService.update`),
  so by construction it never contains a row for the version that's
  currently live; that row doesn't need to exist since the live `scenarios`
  table already holds it. Adding a redundant snapshot-on-every-read (or a
  synthetic "publish snapshot") would be extra writes/rows to keep in sync
  for zero benefit — the fallback is one `if`, not a second write path to
  maintain.
- **Scenario it covers:** an `Attempt` (a later phase) needs to display "the
  scenario as it was when you solved it" regardless of whether that's the
  current version or a past one — this makes both cases resolve through the
  same endpoint uniformly.

## 6. `/scenarios/drafts`, not `/scenarios/{id}/drafts`

- **Chose:** `GET /scenarios/drafts` — a flat list of every draft scenario
  visible to the caller (their own, if contributor; all, if admin).
- **Considered:** the exact path the original plan doc listed,
  `/scenarios/{id}/drafts`.
- **Why this instead:** that path doesn't actually parse as a sensible
  resource — drafts aren't scoped to one existing scenario's id, you're
  listing draft *scenarios themselves*. Read as what it was clearly meant
  to express rather than implemented literally; a minor correction, called
  out explicitly here (and in the controller's own comment) rather than
  silently diverging from what was written down.
- **Scenario it covers:** N/A — routing correction.

## 7. `SecurityConfig` gets an explicit 401 entry point (found via a real test failure)

- **Chose:** `HttpStatusEntryPoint(HttpStatus.UNAUTHORIZED)` wired via
  `.exceptionHandling(...)`.
- **Considered:** leaving Spring Security's default behavior as-is.
- **Why this instead:** discovered directly from
  `ScenarioCrudIntegrationTest` asserting `GET /scenarios/drafts` (no
  token) should 401 — it actually returned 403. Spring Security's default
  fallback (`Http403ForbiddenEntryPoint`), with no `AuthenticationEntryPoint`
  configured, returns 403 for BOTH "no credentials at all" and "valid
  credentials, wrong role," collapsing a distinction any real REST API
  consumer needs (401 means "log in"; 403 means "you're logged in, this
  still isn't for you" — a frontend needs to tell those apart to redirect
  to login vs. show a permissions error). One line fixes it project-wide,
  without touching `@PreAuthorize`'s own (correct-by-default) 403 behavior
  for authenticated-but-wrong-role.
- **Scenario it covers:** an anonymous frontend user hitting a
  login-required endpoint — should be redirected to sign in (401), not
  shown a generic "forbidden" error that looks like something they're
  permanently not allowed to do (403).

## 8. Integration test base class made `@Transactional` — every test method rolls back

- **Chose:** `AbstractIntegrationTest` is now `@Transactional` — each test
  method runs in, and rolls back, its own transaction; Flyway's migrations
  (including the 32-scenario seed) run once at context startup, entirely
  outside any test method's transaction, so every test starts from the
  same seeded baseline.
- **Considered:** leaving tests unannotated (Phase 1's original state),
  relying on each test using distinct/unique ids to avoid collisions.
- **Why this instead:** found directly by `ScenarioSeedMigrationTest`'s
  exact `hasSize(32)` assertion — without isolation, any *other* test class
  that published a scenario (`ScenarioCrudIntegrationTest` does, several
  times) leaked rows into the shared database, silently breaking an exact
  count the moment execution order or the set of tests changed. Unique ids
  per test only prevents *primary-key collisions*, not table-wide count/
  content assertions — the real fix is proper per-method isolation, the
  standard Spring pattern for this exact problem.
- **Scenario it covers:** every future phase's tests (attempts, points,
  leaderboards) will all write to shared tables (`users`, `scenarios`) too
  — this is the point it needed fixing, before more test classes made the
  same silent-leakage mistake harder to untangle.
- **One deliberate exception ahead:** a genuine multi-threaded concurrency
  test (the points-award race condition, Phase 5) needs two real
  connections racing against each other, which one wrapping transaction
  would prevent — that test will override this at the class level rather
  than extend `AbstractIntegrationTest` as-is.

## 9. The 32-scenario migration: extraction script, dollar-quoted SQL, and a real Flyway/JSON collision bug

- **Extraction**: a temporary `tsx` script written *inside* the frontend
  repo (`src/scenarios/__tmp-export-scenarios.ts`), run once via
  `npx tsx`, importing the real `SCENARIOS` array directly (so the export
  can never drift from the actual, type-checked frontend data) and writing
  JSON to disk. Deleted immediately after running — `git status` in the
  frontend repo confirmed clean, nothing committed or left behind. Read-only
  in every sense that matters even though a file briefly existed there.
- **SQL generation**: `tools/migrate-scenarios/generate-seed-sql.js` (plain
  Node, no build step) turns that JSON into a committed
  `V2.1__seed_scenarios.sql` — 32 `INSERT ... ON CONFLICT (id) DO NOTHING`
  statements, so the seed data is part of reproducible schema history
  (every environment, including a fresh Testcontainers instance in CI,
  gets the exact same 32 scenarios automatically) rather than a manual
  post-deploy step someone has to remember.
- **Postgres dollar-quoting** (`$j$...$j$`) instead of manually escaping
  single quotes: JSON blobs and story text routinely contain apostrophes
  (contractions, possessives), and hand-escaping every one is exactly the
  kind of thing that silently breaks on one unusual scenario body. Verified
  no scenario's content contains the literal substring `$j$` before relying
  on it (grepped the exported JSON directly) rather than assuming.
- **A real bug this surfaced**: Flyway's own `${placeholder}` templating
  syntax is unrelated to Postgres dollar-quoting, but the two collide
  textually — a dollar-quote tag immediately followed by JSON content
  starting with `{` produces exactly `$j${"type":...`, which Flyway's
  parser reads as an unconfigured placeholder reference and fails the
  entire migration with `No value provided for placeholder`. Fixed by
  disabling Flyway's placeholder-replacement feature entirely
  (`spring.flyway.placeholder-replacement=false` in `application.yml`) —
  this project has no legitimate use for it, and the fix prevents the same
  collision for every future JSON-embedding migration, not just this one.
  Found via a real test failure's full stack trace (`Caused by:` chain),
  not guessed — the actual `FlywayException` message named the exact
  colliding placeholder text.
