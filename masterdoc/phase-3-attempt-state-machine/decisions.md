# decisions.md — Phase 3: Attempt State Machine (Verify Stubbed)

Decisions specific to the `attempt` package. Project-wide decisions live in
`masterdoc/decisions.md`.

---

## 1. `VerifyClient` is an interface, stubbed for this phase — real HTTP call is Phase 4

- **Chose:** `AttemptService` depends only on the `VerifyClient` interface;
  `StubVerifyClient` (a canned "always 3 stars" fake, with one deliberate
  forced-failure hook for testing) is the only implementation for now.
- **Considered:** building the real `engineering-studio-verify` Node
  service first, then the attempt state machine on top of it.
- **Why this instead:** the state machine (timestamps, pause accounting,
  status transitions, DB writes) is fully testable in complete isolation
  from whether a real grading service exists yet — proving it correct now
  means Phase 4 is purely "swap one Spring bean for an HTTP-calling one,"
  not "build and debug the state machine and the HTTP integration at the
  same time." Same incremental-milestone principle as every phase so far.
- **Scenario it covers:** N/A directly — a sequencing/risk decision, not a
  behavioral one.

## 2. Elapsed time is computed from server timestamps only — verified with a controllable test Clock, not real sleeps

- **Chose:** every timestamp (`startedAt`, `pausedAt`, `submittedAt`) comes
  from the injected `Clock` bean, never `Instant.now()` called directly in
  `AttemptService`. A new `MutableClock` test utility (`support/MutableClock.java`)
  lets a test advance time deterministically between calls
  (`clock.advance(Duration.ofSeconds(30))`), wired in as `@Primary` for
  `AttemptFlowIntegrationTest`.
- **Considered:** proving the elapsed-time math with real `Thread.sleep`
  calls in the test.
- **Why this instead:** a sleep-based test is both slow (seconds of real
  wall-clock wait, on top of Testcontainers' own already-slow startup) and
  imprecise (asserting elapsed time landed in some tolerance window rather
  than an exact value, since real scheduling always adds jitter). The
  `Clock` injection point already existed for exactly this reason (see
  `AppConfig.clock()`'s own Javadoc from Phase 1) — `AttemptFlowIntegrationTest`
  is the first place that actually cashes in that investment, asserting an
  *exact* 50-second elapsed time (30s active + 20s active, with a 100s
  pause in between correctly excluded) in under a second of real test time.
- **Scenario it covers:** every future phase that computes anything
  time-based (streaks, daily-challenge day boundaries, points'
  `speedFactor`) can reuse the same `MutableClock` pattern rather than
  re-inventing time-control-for-tests each time.

## 3. Submit's transaction shape: verify call outside any transaction, exactly one of two independent transactional writes afterward

- **Chose:** `AttemptService.submit` itself is NOT `@Transactional`. It
  computes elapsed/paused time in memory (no DB write), calls
  `VerifyClient.verify(...)` unguarded by any transaction, then calls
  either `AttemptFinalizer.finalizeVerified(...)` (success) or
  `AttemptFinalizer.markVerifyFailed(...)` (failure) — both `@Transactional`
  methods on a **separate** Spring bean, `AttemptFinalizer`.
- **Considered:** making `submit` itself `@Transactional`, with the verify
  call happening partway through, and a caught exception setting
  `VERIFY_FAILED` before re-throwing.
- **Why this instead:** two real problems with the single-transaction
  version. First, correctness: if the whole method is one transaction and
  an exception propagates out of it (even a caught-and-rethrown one, if the
  transaction is already marked rollback-only by that point), Spring rolls
  back the *entire* transaction — including the `VERIFY_FAILED` status
  write that was supposed to survive the failure. Second, a Spring-specific
  gotcha: `@Transactional` is implemented via a proxy wrapping the bean:
  calling another `@Transactional` method on `this` from inside the same
  class bypasses that proxy entirely (self-invocation isn't intercepted),
  so even structuring it as "one big method calling two @Transactional
  helper methods on itself" silently wouldn't create the two independent
  transaction boundaries it looks like it would. Moving the finalization
  methods to a genuinely separate bean (`AttemptFinalizer`) sidesteps both
  problems: real proxy boundaries, and a failure in one write can never
  roll back the other because they were never in the same transaction to
  begin with.
- **Scenario it covers:** exactly the scenario named in the original plan's
  open item — a verify-service timeout or failure (a real possibility once
  Phase 4 makes this a genuine network call) must land the attempt in
  `VERIFY_FAILED` and leave it resubmittable, never silently lose that
  status update to an unrelated rollback.

## 4. `markVerifyFailed` touches only `status` — no other field is reset

- **Chose:** on verify failure, `attempt.startedAt`/`pausedAt`/
  `totalPausedSeconds` are left completely untouched; only `status` flips
  to `VERIFY_FAILED`.
- **Considered:** resetting the attempt to some "clean" pre-submit state on
  failure.
- **Why this instead:** nothing else was ever computed or awarded on
  failure — there's nothing to undo. Leaving timing fields alone also means
  a resubmit naturally recomputes elapsed time from the real, unmodified
  history (including whatever time was spent between the failed attempt
  and the retry), rather than the service having to reconstruct or fake a
  "correct" prior state.
- **Scenario it covers:** the elapsed-time computation is deliberately
  keyed off `attempt.getPausedAt() != null` (an open pause genuinely
  exists right now), not `attempt.getStatus() == PAUSED` — so a resubmit
  after a `VERIFY_FAILED` that happened while paused still closes that
  pause out correctly, even though the status field itself no longer reads
  `PAUSED` at that point.

## 5. No guard against a user starting two concurrent attempts on the same scenario

- **Chose:** `POST /attempts` doesn't check for an existing
  `IN_PROGRESS`/`PAUSED` attempt on the same scenario before creating a new
  one — multiple concurrent attempts are allowed.
- **Considered:** rejecting a second `start` while an earlier attempt on
  the same scenario is still open, or transparently returning the existing
  one.
- **Why this instead:** deferred as an explicit, conscious scope cut rather
  than an oversight — the frontend naturally only ever has one active
  attempt in flight at a time (there's one canvas, one active session), so
  this is a theoretical API-level gap, not a real product problem observed
  yet. Revisit if it ever actually causes confusion (e.g. a user opening
  two browser tabs).
- **Scenario it covers:** N/A — flagged as a deferred consideration, not a
  fix.
