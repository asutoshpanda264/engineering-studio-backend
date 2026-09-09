# explain_attempt.md — the `attempt` package

How the start/pause/resume/submit lifecycle actually works. For *why* each
choice was made, see this folder's `decisions.md`.

## The state machine

```
POST /attempts                         POST .../submit (from IN_PROGRESS)
        │                                          │
        ▼                                          ▼
 ┌─────────────┐   POST .../pause    ┌────────┐   ┌───────────┐
 │ IN_PROGRESS │ ───────────────────▶│ PAUSED │   │ SUBMITTED │ (terminal — no further action)
 └─────────────┘◀─────────────────── └────────┘   └───────────┘
        │            POST .../resume      │              ▲
        │                                  │  submit      │ verify succeeds
        └──────────────────────────────────┴──────────────┘
                                            │
                                  verify fails/times out
                                            ▼
                                   ┌────────────────┐
                                   │ VERIFY_FAILED  │──▶ resubmittable (loops back to submit)
                                   └────────────────┘
```

`NO_PRESSURE` mode skips the pause/resume half of this diagram entirely —
`pause`/`resume` both reject with 409 for a `NO_PRESSURE` attempt (see
`AttemptService.pause`'s mode check); `submit` works the same either way,
just without any elapsed-time bookkeeping.

## Who can call what

Any authenticated user (no role restriction — `USER`/`CONTRIBUTOR`/`ADMIN`
all qualify) can start/pause/resume/submit **their own** attempts;
`AttemptService`'s per-method ownership check (`attempt.getUser().getId()
.equals(actorId)`) is what actually enforces "own," not `@PreAuthorize`.
`GET /attempts/{id}` additionally allows an `ADMIN` to view *any* user's
attempt (support/moderation use case) — the one endpoint here with a role
bypass.

## The elapsed-time calculation, precisely

Three server-recorded instants and one running total drive everything:
`startedAt`, `pausedAt` (non-null only while currently paused),
`totalPausedSeconds` (accumulated from every *closed* pause interval), and
`submittedAt`/now.

- **`pause`**: records `pausedAt = now`, flips status to `PAUSED`, opens an
  `AttemptPauseInterval` row (`pausedAt`, `resumedAt = null`).
- **`resume`**: adds `now − pausedAt` to `totalPausedSeconds`, clears
  `pausedAt`, flips back to `IN_PROGRESS`, closes the open
  `AttemptPauseInterval` row (`resumedAt = now`).
- **`submit`**: if there's *still* an open pause at submit time (the caller
  submitted directly from `PAUSED`, or is resubmitting after a
  `VERIFY_FAILED` that happened while paused), that gap is folded into
  `totalPausedSeconds` the same way `resume` would, in memory, before the
  final calculation:

  ```
  elapsedSeconds = (submittedAt − startedAt) − totalPausedSeconds
  ```

  floored at 0 as a defensive guard against clock-skew edge cases. Computed
  only for `TIMED` mode — `NO_PRESSURE` attempts always submit with
  `elapsedSeconds = null`.

`AttemptFlowIntegrationTest.fullTimedLifecycleComputesElapsedTimeExcludingPausedTime`
proves this exactly: 30s active → pause → 100s paused → resume → 20s active
→ submit asserts `elapsedSeconds == 50`, not 150 — using a controllable
test `Clock` (see `decisions.md` #2), not real sleeps.

## What "submit" actually does, step by step

1. Load the attempt, check ownership, check it isn't already `SUBMITTED`
   or `EXPIRED`.
2. Compute `totalPausedSeconds`/`elapsedSeconds` **in memory only** — no DB
   write yet.
3. Build a `VerifyRequest` (scenario id, the version this attempt started
   against, the scenario's seed, and the client's submitted graph) and call
   `VerifyClient.verify(...)` — today, `StubVerifyClient`; a real HTTP call
   to `engineering-studio-verify` from Phase 4 onward.
4. **On success**: `AttemptFinalizer.finalizeVerified(...)` — one
   transaction that closes any still-open pause interval, sets `SUBMITTED`,
   stores `submittedAt`/`elapsedSeconds`/`totalPausedSeconds`, the
   submitted graph, and the verify result (metrics/evaluation/score).
5. **On failure**: `AttemptFinalizer.markVerifyFailed(...)` — a *different*
   transaction that touches only `status`, leaving everything else exactly
   as it was so a retry computes correctly (see `decisions.md` #3/#4 for
   why this needs to be two separate transactional writes on a separate
   bean, not one method with a catch block).

## What's still a stub, on purpose

`StubVerifyClient` always returns the same canned "passed, 3 stars" result
for any scenario except one reserved testing sentinel id
(`verify-failure-trigger`, which always throws) — see `decisions.md` #1.
Nothing in this phase computes points, updates progress, or touches a
leaderboard; those packages don't exist yet (Phases 5/6). `points_awarded`
on the `attempts` table is a real column already (matching the eventual
schema) but nothing writes to it yet.

## Testing

`AttemptFlowIntegrationTest` — 7 tests: the full timed lifecycle with exact
elapsed-time assertions, `NO_PRESSURE` mode's pause rejection and null
elapsed time, attempting a non-published scenario (409), ownership
boundaries (403 for a non-owner, admin bypass on `GET`), double-submit
rejection (409), and the `VERIFY_FAILED` → resubmit path using the stub's
forced-failure hook.
