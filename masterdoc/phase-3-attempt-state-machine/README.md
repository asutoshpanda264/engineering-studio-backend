# Phase 3 — Attempt State Machine (Verify Stubbed)

**Status:** ✅ done, verified against a real Postgres via Testcontainers.

## What shipped

The full start/pause/resume/submit lifecycle for attempting a scenario,
with server-authoritative elapsed-time accounting (never trusts a
client-reported duration) and a `VerifyClient` seam — stubbed for now
(`StubVerifyClient`), a real HTTP call to `engineering-studio-verify` comes
in Phase 4. `TIMED` and `NO_PRESSURE` modes both work; `NO_PRESSURE` skips
all pause/timer semantics as designed. A `VERIFY_FAILED` status exists for
a failed/timed-out verify call, and stays cleanly resubmittable.

Also landed: `MutableClock`, a reusable test utility for asserting
time-based logic exactly instead of via real sleeps — see
`decisions.md` #2, likely to get reused by Phases 6/7 (streaks,
daily-challenge boundaries).

## Files in this repo

- `api/src/main/java/.../attempt/` — `Attempt`, `AttemptPauseInterval`,
  `AttemptMode`, `AttemptStatus`, `AttemptMapper`, `AttemptService`,
  `AttemptFinalizer`, `AttemptController`, repositories, DTOs
- `api/src/main/java/.../attempt/verify/` — `VerifyClient`, `VerifyRequest`,
  `VerifyResult`, `VerifyException`, `StubVerifyClient`
- `api/src/main/resources/db/migration/V3__attempt.sql`
- `api/src/test/java/.../attempt/AttemptFlowIntegrationTest.java`
- `api/src/test/java/.../support/MutableClock.java`

## Docs in this folder

- `decisions.md` — 5 entries: stubbing the verify call deliberately before
  building the real service, the controllable-test-clock approach, the
  two-transaction submit design (and the Spring self-invocation gotcha it
  avoids), why failure handling only touches `status`, and a conscious
  scope cut (no duplicate-concurrent-attempt guard).
- `explain_attempt.md` — the state machine diagram, the elapsed-time
  calculation in full, and what "submit" actually does step by step.
- `industry.md` — how real-world systems solve the same problems (server-
  authoritative timing, state machines, the stub-then-real-integration
  seam, split transaction boundaries, resubmittable failures, and the
  missing concurrent-attempt guard) and how this project's approach
  compares.

## Test status

`AttemptFlowIntegrationTest` — 7/7. `ScenarioSeedMigrationTest` re-verified
unaffected by the new V3 migration — 3/3.
