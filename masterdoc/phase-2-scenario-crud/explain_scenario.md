# explain_scenario.md — the `scenario` package

How the CRUD + publish workflow + versioning actually work. For *why* each
choice was made, see this folder's `decisions.md`.

## The state machine

```
        POST /scenarios                POST /scenarios/{id}/publish
              │                                    │
              ▼                                    ▼
          ┌───────┐  PUT (owner+draft, or admin) ┌───────────┐  POST .../archive  ┌──────────┐
          │ DRAFT │ ────────────────────────────▶│ PUBLISHED │───────────────────▶│ ARCHIVED │
          └───────┘         (bumps version)       └───────────┘                    └──────────┘
              │                                        │
       DELETE (admin only)                    PUT (admin only, bumps version)
        hard-deletes the row                   — a contributor can no longer
                                                  edit their own scenario once
                                                  it's published (decisions.md #4)
```

- **Create** (`POST /scenarios`, contributor or admin): always lands as
  `DRAFT`, `version = 1`, `createdBy` = the caller. No content is visible
  publicly yet.
- **Publish** (`POST /scenarios/{id}/publish`, admin only): `DRAFT →
  PUBLISHED` only — publishing an already-published or archived scenario is
  a 409.
- **Archive** (`POST /scenarios/{id}/archive`, admin only): `PUBLISHED →
  ARCHIVED` only. The row (and every historical `Attempt`/`ProblemProgress`
  that references it) stays intact — archiving removes it from
  `GET /scenarios`, it doesn't delete anything.
- **Delete** (`DELETE /scenarios/{id}`, admin only): only while still
  `DRAFT` — a 409 otherwise, with the response telling the caller to
  archive instead. Never lets a published/attempted scenario disappear
  outright.

## Versioning: what actually gets snapshotted, and when

`ScenarioService.update` does two things in one transaction, in this exact
order:
1. Serialize the scenario's **current** state (before any change) into
   `scenario_versions`, tagged with its **current** version number.
2. Apply the new content to the live row and increment its version.

So `scenario_versions` only ever holds *past* versions — the live
`scenarios` row is always the current one. `GET /scenarios/{id}/versions/{n}`
reads from `scenario_versions` for any past version, or falls back to the
live row when `n` equals the scenario's current version (which has no
`scenario_versions` row, by construction — see `decisions.md` #5). This is
what makes an `Attempt`'s `scenarioVersion` field (a future phase)
meaningful: whatever version a student solved against stays exactly
reconstructable, forever, even after the scenario's live content moves on.

## JSONB fields: how they cross the Java↔database boundary

Most of a `Scenario`'s body (`topics`, `startingEntities`,
`trafficPattern`, `constraints`, `hints`, `learningGoals`,
`optimalSolution`, etc.) is stored as JSONB, mapped in the `Scenario`
entity as plain `String` fields — Hibernate never sees these as anything
but opaque text. `ScenarioMapper` is the one place that ever converts
between that raw JSON string and a typed `ScenarioRequest`/`ScenarioResponse`
DTO, using `JsonUtil` (a small wrapper around Jackson 3.x — see
`decisions.md` #1/#2 for why that specific library, deliberately, over the
classic Jackson 2.x also present on this project's classpath).

`ScenarioRequest`'s nested fields (`startingEntities`,
`trafficPattern`, etc.) are typed as plain `Map<String,Object>`/
`List<Map<String,Object>>` rather than fully-modeled Java classes mirroring
every one of the frontend's nested TypeScript unions (`TrafficPattern`'s
`constant`/`burst`/`ramp` variants, for instance) — Bean Validation checks
that these fields are *present and the right JSON kind*, not their full
internal shape. Deep structural validation of a submitted architecture is
the verify-service's job (a later phase), which actually runs the thing —
duplicating that validation here, in a shape Java's type system can't
really express any more precisely than "a map," wouldn't catch anything
real.

## The 32-scenario seed, and how it reaches this table

`V2.1__seed_scenarios.sql` is a committed Flyway migration — not a runtime
step — containing 32 literal `INSERT` statements generated from the
frontend's real `SCENARIOS` array (see `decisions.md` #9 for the
extraction/generation process). Every environment that runs this project's
migrations (local dev, CI's Testcontainers instances, a real deploy) ends
up with the exact same 32 published scenarios automatically, with no
separate "remember to seed the database" step.

## Testing

`ScenarioCrudIntegrationTest` covers the full state machine end to end
(draft → publish → public visibility → edit-bumps-version →
old-version-still-fetchable) plus every RBAC boundary (contributor editing
someone else's draft, editing after publish, non-admin attempting
publish/archive/delete). `ScenarioSeedMigrationTest` validates the V2.1
migration itself — exact count, status, and a full JSONB round-trip on a
scenario with nearly every optional field populated, so a silently dropped
or mis-mapped field would fail loudly rather than just being absent from a
response nobody happened to check.
