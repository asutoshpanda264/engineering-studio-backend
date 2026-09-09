# decisions.md — Phase 4: Node Verify-Service, Real Integration

Decisions specific to building `verify/` and wiring `api/` to call it for
real. Project-wide decisions live in `masterdoc/decisions.md` (including
#6/#7, `verify/`'s own stack choices and the monorepo restructure — both
made during this phase).

---

## 1. Vendoring approach: a shell script copying specific files, run manually and committed

- **Chose:** `verify/sync-vendor.sh` copies exactly seven paths from the
  frontend repo (`src/simulation/` whole dir, `src/scenarios/{types,validator}.ts`,
  `src/lib/{scenarioScoring,costEngine,architectureValidation,entityConfigSchema}.ts`)
  into `verify/vendor/src/`, preserving the frontend's own relative
  structure so a matching `@/*` → `./vendor/src/*` tsconfig alias makes
  every vendored file's internal `@/...` import resolve completely
  unmodified — zero edits to the copied files themselves. Run manually,
  the result committed to git.
- **Considered:** a git submodule pointing at the frontend repo; an npm
  package published from the frontend and installed as a dependency.
- **Why this instead:** a submodule solves "stay in sync automatically" at
  the cost of submodule ergonomics (a notoriously easy thing to get wrong
  — detached HEAD confusion, forgetting to update, CI needing extra flags)
  for a relationship that only needs to sync occasionally, not
  continuously. An npm package would mean maintaining a whole publish
  pipeline for internal-only code. A plain script + committed output
  accepts "someone has to remember to re-run this after an engine change"
  as a real but small cost, in exchange for the vendored code being
  ordinary, greppable, git-blameable source — no indirection to understand
  what's actually running.
- **Determined precisely which files were needed**, rather than vendoring
  broadly "to be safe": grepped every non-type-only (`import`, not `import
  type`) cross-module reference across the whole dependency closure before
  writing the script, confirming zero React/Zustand/`@xyflow` imports
  anywhere in the closure (`src/simulation/` was already documented
  framework-independent; this extends that same property to the three
  `src/lib/*.ts` files scoring depends on, which hadn't been explicitly
  verified before).

## 2. The `fakeNode` shape bug — top-level `type` vs. `data.entityType`, caught by the fixture-parity test

The single most valuable thing this phase's testing methodology found.
`scoreScenario`'s `nodes` parameter is typed as the frontend's real
`ArchitectureNode` (a React Flow node), but every function that actually
reads one only touches `.id` and fields under `.data`. The frontend's own
(unexported) `fakeNode()` helper inside `scenarioScoring.ts` builds exactly
this shape for its optimal-solution scoring path:
```ts
{ id, type: "component", position, data: { entityType: type, label: id, config } }
```
`graphAdapter.ts`'s first draft got this backwards — it put the real entity
type (`"api"`, `"database"`, ...) at the top-level `type` field and never
set `data.entityType` at all. Every function that reads `.data.entityType`
directly (`costEngine.ts`'s `estimateCost`, `architectureValidation.ts`'s
`hasUnguardedBackendAccess`/`hasUnguardedIrreversibleAction`) silently
found nothing there, and every entity was treated as "not-yet-priced" and
skipped — no error, no warning, just a submission that always scored
`actualCostUsd: 0`.

- **How it was caught**: the fixture-parity test initially passed on
  `successRate`/`p95Latency`/`gatesPassed` (those don't depend on
  `data.entityType`), which made the bug easy to miss — it only surfaced
  from noticing `actualCostUsd: 0` looked wrong in a manual HTTP smoke
  test, then confirming against the real engine that a *correct* input
  produces a real (~$762/mo), non-zero cost.
- **The fix**: `graphAdapter.ts`'s `toFakeArchitectureNodes` now builds the
  exact same shape `fakeNode()` does, field for field, with a comment
  explaining why the two-different-node-shapes split exists at all
  (`runSimulation` wants flat `EntityConfig`s; `scoreScenario`/`costEngine`/
  `architectureValidation` want the nested React-Flow-shaped fake).
- **Scenario it covers**: this is exactly the class of bug a fixture-parity
  test against a real reference is *for* — a type-only, structurally-typed
  contract (TypeScript, never checked at runtime since `tsx` transpiles
  without type-checking — see #4) between two files that both compiled
  fine individually and only diverged in behavior. A test asserting "do
  the actual numbers match," not "does this compile," is what caught it.

## 3. `VerifyRequest` carries the full scenario body, not an id/version/seed triple

- **Chose:** `api`'s `VerifyRequest` record is `{scenario: Map<String,Object>,
  graph: Map<String,Object>}` — the *entire* scenario body (constraints,
  budget, trafficPattern, seed, optimalSolution, ...), not a hand-picked
  subset. `AttemptService.submit` builds it via
  `scenarioService.getVersion(scenario.getId(), attempt.getScenarioVersion())`
  — the exact same method the public `GET /scenarios/{id}/versions/{n}`
  endpoint uses (see `scenario/decisions.md` #5).
- **Considered:** the Phase 3 stub-era shape (`scenarioId`, `scenarioVersion`,
  `seed`, `graph`), with `verify/` looking up scenario details some other
  way.
- **Why this instead:** `verify/` is deliberately stateless — it has no
  database connection of its own, so Postgres (via `api`) is the only
  source of truth it can ever see for scenario content. `scoreScenario`
  alone needs `constraints`, `budgetUsd`, `requiresGatedToolCalls`, and
  `optimalSolution` (for the legendary-tier comparison) — sending "the
  fields I think scoring needs today" risks a contract change every time a
  scoring refinement reads one more field; sending the whole body means it
  never needs to change again for that reason. Reusing `getVersion` instead
  of a fresh scenario fetch is what makes the anti-cheat fairness guarantee
  real: verification always runs against the scenario as it existed when
  the attempt *started*, never against edits an admin made mid-attempt.

## 4. Real npm package versions checked before pinning — not guessed from training data

- **Chose:** ran `npm view <pkg> version` for every dependency
  (`express`, `vitest`, `tsx`, `typescript`, `@types/node`, `@types/express`)
  before writing `package.json`, rather than writing remembered version
  numbers and letting `npm install` resolve whatever it resolved.
- **Why:** Phase 1 already hit real breakage from guessing a plausible
  version string instead of checking (`4.1.1.RELEASE` — see
  `phase-1-auth-rbac/explain_boot4-migration.md`'s sibling story in
  `masterdoc/decisions.md` #3). Checking up front here found real
  surprises worth knowing about explicitly: TypeScript is at major version
  7 now, Vitest at major version 5 — both well past what training data
  would suggest as "current." Pinning to what's actually current, not what
  seems current, avoided a repeat of the same mistake in a new ecosystem.
- **A related, smaller thing worth knowing**: `npm install` on this
  Node/npm version blocked `esbuild`'s postinstall script by default
  (a newer `allow-scripts` security feature) without approval — `tsx`
  (which depends on esbuild) worked correctly anyway, confirmed by running
  it before assuming anything was broken, rather than reflexively
  approving an arbitrary postinstall script.
- **Scenario it covers:** the same class of risk every "trust training
  data over checking" decision carries — a package registry's real state
  is always the authority, training data is a prior, not a source.

## 5. Verified twice with real fakes, once for real: unit test, HTTP smoke test, full end-to-end

Three distinct levels of proof, deliberately, not just one:
1. `verify/test/verify.fixtureParity.test.ts` — calls `verify()` directly
   (no HTTP), asserting exact numeric equality against the real,
   non-vendored frontend engine's own output for the same input (see #2's
   bug-discovery story — this test is what found it).
2. A manual `curl` against a locally-running `verify/` server, confirming
   the Express/HTTP layer itself (routing, JSON parsing, error handling)
   works on top of the already-proven `verify()` function.
3. A full end-to-end run: real Spring Boot (`api`, Testcontainers Postgres,
   the real seeded `url-shortener` scenario from the actual migration) +
   real `verify/` process, driven entirely over HTTP via `curl` through
   `/auth/register` → `/auth/login` → `POST /attempts` → `POST
   /attempts/{id}/submit` — confirming `HttpVerifyClient`'s real network
   call, timeout config, and response deserialization all work, and that
   the numbers match #1's fixture exactly (`optimalComposite: 0.8053`
   independently matched `url-shortener.ts`'s own documented "composite
   0.805" for its optimal solution — a real, unplanned confirmation of the
   legendary-tier logic too).

Each level catches a different class of bug (business logic; HTTP
plumbing; real cross-process integration) — collapsing to just one of
these would have missed something: #1 alone wouldn't catch an HTTP
serialization mismatch, #2 alone wouldn't catch a real timeout/connection
issue, and neither #1 nor #2 alone proves `api` and `verify` genuinely
agree on the wire contract.

## 6. `StubVerifyClient` deleted from `api`'s main source; a `FakeVerifyClient` test double replaces it, test-scoped only

- **Chose:** the Phase 3 `StubVerifyClient` (a `@Component`, shipped in
  main source) is gone. `AttemptFlowIntegrationTest` now overrides the
  `VerifyClient` bean with a small `support.FakeVerifyClient` — same
  canned-response and forced-failure-sentinel behavior, but it only exists
  under `src/test/java`, never shipped.
- **Considered:** keeping `StubVerifyClient` around behind a Spring profile
  as a "run locally without needing `verify/` up" convenience.
- **Why this instead:** the real integration is the point of this phase —
  leaving a full stub implementation in main source, reachable via a
  profile flag, is exactly the kind of thing that quietly bit-rots (does
  it still return realistic shapes after `verify/`'s response format
  changes? nobody would necessarily notice). `api`'s Java integration
  tests don't need a live `verify/` process running (see
  `masterdoc/explain_testing.md` — this environment is resource-constrained
  enough without adding a third heavy process to every test run); the real
  HTTP integration is proven separately and more rigorously by #5 above,
  which is a better substitute for "can I develop without `verify/`
  running" than a stub silently drifting out of sync in production code.
- **Scenario it covers:** avoiding two implementations of "what does a
  verify response look like" (one real, one stubbed) that can independently
  drift — the test double is intentionally small, obviously fake, and
  nowhere near a code path that could accidentally ship.
