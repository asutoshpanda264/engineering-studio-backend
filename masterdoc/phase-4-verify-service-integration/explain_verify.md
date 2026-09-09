# explain_verify.md — how `verify/` actually scores a submission

How the pieces fit together. For *why* each choice was made, see this
folder's `decisions.md`.

## The request, end to end

```
api/ (Spring Boot)                          verify/ (Node/Express)
─────────────────────                       ──────────────────────
AttemptService.submit
  scenarioService.getVersion(id, version)
    → full scenario body (Map)
  HttpVerifyClient.verify({scenario, graph})
       ── POST /verify ──────────────────▶  server.ts validates the body shape
                                             (400 if scenario/graph missing)
                                             ▼
                                             verify.ts:
                                               graphAdapter.toEntityConfigs(nodes)
                                               graphAdapter.toConnectionConfigs(...)
                                                 → runSimulation(config)
                                                    (vendored, unmodified)
                                               graphAdapter.toFakeArchitectureNodes(nodes)
                                                 → scoreScenario(scenario, result, nodes, connections)
                                                    (vendored, unmodified — internally
                                                     calls evaluateScenario + estimateCost +
                                                     architecture-validation checks)
                                             ▼
       ◀── {metrics, evaluation, score} ──  200 JSON response
  finalizer.finalizeVerified(...) or
  finalizer.markVerifyFailed(...)
```

## Why the graph gets adapted into TWO different shapes

The vendored functions were never written with an HTTP API in mind — they
expect exactly the shapes the frontend's own canvas/store produce
in-process. Two different vendored functions want two different shapes for
the "same" node data:

- **`runSimulation`** wants `SimulationConfig.entities: EntityConfig[]` —
  flat: `{id, type, position, config}`. This is already what the client
  submits, so `graphAdapter.toEntityConfigs` barely transforms anything.
- **`scoreScenario`** (and the two `architectureValidation.ts` checks it
  calls internally) want `nodes: ArchitectureNode[]` — a React Flow node
  type, whose only fields anything actually *reads* at runtime are `.id`
  and things nested under `.data` (`.data.entityType`, `.data.config`).
  `graphAdapter.toFakeArchitectureNodes` builds this shape by hand — the
  exact same trick the frontend's own `scenarioScoring.ts` already uses
  internally (an unexported `fakeNode()` helper) for its optimal-solution
  scoring path, just applied to the *student's* submitted nodes instead.

Getting the second shape's fields right the first time was harder than it
looked — see `decisions.md` #2 for the actual bug this caused (`type` vs
`data.entityType`) and how the fixture-parity test caught it.

## Why this works without the vendored files being edited at all

`import type { ... } from "@/store/workshopStore"` (and similar type-only
imports the vendored files carry) get **fully erased** before this service
ever runs `tsx` transpiles TypeScript without type-checking (like Babel —
fast, no full program analysis), and `import type`/inline type-only
`import()` syntax is specifically designed to be staticly strippable
without needing to resolve the module at all. So a vendored file's
type-only reference to a path that doesn't exist anywhere in this repo
(`@/store/workshopStore` — deliberately never vendored, since it's a
Zustand store with React Flow types) simply vanishes at transpile time and
is never resolved. Only genuinely-called-at-runtime imports
(`import { evaluateScenario } from "@/scenarios/validator"`, etc.) need
their target to actually exist under `vendor/src/` — and every one of
those was identified up front (`decisions.md` #1) before writing
`sync-vendor.sh`.

## What's deliberately *not* modeled precisely

`VerifyPayload.scenario` is typed as `Record<string, unknown>` in
`verify.ts`, not the frontend's real `Scenario` interface — the vendored
functions get it via an explicit, commented `as unknown as ...` cast at
each call site. `tsx`'s lack of type-checking (see above) means this isn't
a compile-time hole being papered over so much as an honest acknowledgment
that nothing here is actually type-checked at build time today — worth
knowing if a stricter CI type-check step is ever added later, since a
handful of these casts would need real attention at that point, not a
blanket unwind.

## Testing

`verify.fixtureParity.test.ts` is the one test that matters most in this
repo — see `decisions.md` #2 and #5 for what it caught and the layered
verification strategy (unit → HTTP smoke → full end-to-end) it's the
foundation of. `npm test` runs it in under 2 seconds with no external
dependencies (no Docker, no database) — it only needs the vendored engine
code and a fixture, which is part of why it's cheap enough to have been
run dozens of times while chasing the `fakeNode` bug.
