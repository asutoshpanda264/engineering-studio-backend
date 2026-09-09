# decisions.md — Phase 5: Points + PointsLedger + Upgrade-Only ProblemProgress

Decisions specific to the `points` and `progress` packages. Project-wide
decisions live in `masterdoc/decisions.md`.

---

## 1. `PointsCalculator` is a pure, static-method class — no Spring, no database

- **Chose:** every formula piece (`basePoints`, `starsMultiplier`,
  `speedFactor`, `totalPoints`, `defaultTimeLimitSeconds`) is a static
  method on a final class with a private constructor — no `@Component`, no
  injected dependencies, nothing but arithmetic and `switch` expressions.
- **Considered:** a `@Service`-annotated `PointsService` doing the same
  math inline as part of the larger progress-recording flow.
- **Why this instead:** the formula is exactly the kind of logic that
  benefits from being isolated and boringly testable — `PointsCalculatorTest`
  runs 8 cases in 0.37s with no Testcontainers, no Spring context, because
  there's nothing to wire up. Every star tier, both speed-factor extremes
  at both difficulty extremes, and the clamping/null-elapsed edge cases are
  covered explicitly. If the formula ever needs tuning (the `SWING`
  constant, the star-tier multipliers), this is the one file to touch and
  the one test file that proves it didn't break anything.
- **Scenario it covers:** confidence in the actual arithmetic, independent
  of everything else this phase built (the locking, the transaction
  wiring) — those are tested separately, deliberately, so a failure in one
  area points precisely at the other.

## 2. The upgrade-only race: `ensureRowExists` (upsert-insert) + a separately-named pessimistic-lock read

- **Chose:** two repository methods working together —
  `ensureRowExists` (a native `INSERT ... ON CONFLICT (user_id,
  scenario_id) DO NOTHING`) always runs first, unconditionally; then
  `lockByUserIdAndScenarioId` (`@Lock(PESSIMISTIC_WRITE)` — Postgres
  `SELECT ... FOR UPDATE`) reads the now-guaranteed-to-exist row and holds
  it locked for the rest of the transaction.
- **Considered:** a single `@Lock(PESSIMISTIC_WRITE)` findOrCreate method;
  a native SQL upsert with the whole "only update if better" business
  logic embedded via `GREATEST()`/`CASE` expressions.
- **Why this instead:** Postgres row-level locking can't protect a row
  that doesn't exist yet — two concurrent *first-ever* solves of the same
  scenario by the same user would otherwise both see "no row," both try to
  insert, and one would fail with a unique-violation instead of gracefully
  becoming an update. `ON CONFLICT DO NOTHING` makes the existence-check
  step itself idempotent and race-safe, so by the time the lock is
  acquired, the row is guaranteed to be there. A single upsert-with-embedded-logic
  SQL statement would avoid the two-step shape, but makes "was this an
  improvement, what's the delta, do we need a ledger entry" much harder to
  compute — that logic stays in readable Java instead.
- **Scenario it covers:** exactly the plan's own named test scenario —
  two simultaneous submits for the same (user, scenario) — see #3 below
  for how this was actually verified, not just asserted to work.

## 3. Two concurrency tests, not one — and a real lesson about testing races

- **Chose:** `ProblemProgressConcurrencyTest` has two tests:
  `twoSimultaneousSubmitsNeverDoubleAwardPoints` (an end-to-end scenario —
  two real attempts, two real threads, asserting the final numbers are
  correct) and `pessimisticLockActuallyBlocksAConcurrentReader` (a direct,
  deterministic proof that the lock mechanism itself blocks a concurrent
  reader for as long as expected).
- **A real finding while building this**: the first test alone is **not
  sufficient proof**. Temporarily removing `@Lock(PESSIMISTIC_WRITE)`
  entirely and re-running `twoSimultaneousSubmitsNeverDoubleAwardPoints`
  still passed, 3 times in a row. The reason: a `CyclicBarrier`-synchronized
  start only guarantees both threads *begin* at roughly the same moment —
  it says nothing about whether their actual database reads land close
  enough together to race. In practice, one thread's whole
  read → compute → write → commit cycle (a handful of milliseconds) often
  finishes entirely before the other thread's first query even executes,
  especially with JVM thread start-up and Hibernate's first-call overhead
  in the mix — so the bug this test was meant to catch simply never had a
  chance to manifest, lock or no lock.
- **The fix**: `pessimisticLockActuallyBlocksAConcurrentReader` tests the
  mechanism directly instead of hoping for timing luck — one thread opens
  a transaction, acquires the lock, and holds it open (via a
  `CountDownLatch`) for a fixed 400ms; a second thread's attempt to
  acquire the *same* lock is timed, and must take at least ~350ms
  (allowing scheduling jitter), proving it genuinely blocked rather than
  reading a stale value while the first transaction was still in flight.
  Verified honestly in both directions: re-running this specific test with
  the lock removed showed the second attempt returning in ~20ms instead of
  blocking — a real, reproducible failure, not a hypothetical one.
- **Scenario it covers:** the general lesson, worth remembering beyond
  this one test — a concurrency test that only asserts *end-state
  correctness* under a best-effort race can pass for the wrong reason
  (no real overlap happened) and give false confidence. Proving the actual
  blocking mechanism directly and deterministically is what makes the
  guarantee trustworthy, not just plausible.

## 4. Points/progress recording lives inside `AttemptFinalizer.finalizeVerified`'s existing transaction, not a separate step

- **Chose:** `AttemptFinalizer.finalizeVerified` (Phase 3/4) now also calls
  `problemProgressService.recordOutcome(...)` as its last step, still
  inside the same `@Transactional` method — a normal cross-bean call (not
  the self-invocation problem that method's own Javadoc already warns
  about), so it participates in the same transaction automatically.
- **Considered:** a separate, subsequent transaction for points/progress,
  triggered after the attempt's SUBMITTED status is already committed.
- **Why this instead:** an attempt marked SUBMITTED with its points/progress
  silently unrecorded (or the reverse — points awarded for an attempt that
  isn't actually marked SUBMITTED) would be a real, hard-to-detect data
  integrity bug. Keeping both in one transaction means they can only ever
  commit together or roll back together — there's no window where one
  exists without the other.
- **Scenario it covers:** a crash, a thrown exception from
  `ProblemProgressService` (a malformed `stars` value from `verify/`, say)
  partway through — the whole submit rolls back cleanly, the attempt
  reverts to resubmittable, nothing partially applied.

## 5. A real regression, found by re-running Phase 1's own test suite: `GlobalExceptionHandler`'s new catch-all caught `AccessDeniedException` too

- **What happened:** adding `@ExceptionHandler(Exception.class)` (a
  reasonable general improvement — every error response should share the
  `ApiError` shape, not just the ones explicitly anticipated) immediately
  broke `AuthFlowIntegrationTest.userIsForbiddenFromAdminEndpointUntilPromoted`
  (a **Phase 1** test, untouched since Phase 1) — a USER token hitting an
  admin-only endpoint started returning 500 instead of 403.
- **Why:** `@PreAuthorize`'s method-security interceptor throws
  `org.springframework.security.access.AccessDeniedException`, itself a
  `RuntimeException` — Spring MVC's `@ExceptionHandler` resolution runs
  *before* the exception would ever reach Spring Security's own
  filter-based translation (`ExceptionTranslationFilter`, which normally
  turns this into a 403), so the new catch-all intercepted it first.
- **The fix**: an explicit `@ExceptionHandler(AccessDeniedException.class)`
  returning 403 — Spring resolves handlers by most-specific matching
  exception type regardless of declaration order, so it and the generic
  `Exception` handler coexist safely once both exist.
- **Scenario it covers:** the concrete reason this project re-runs earlier
  phases' test suites after a change that looks unrelated to them, rather
  than assuming "I only touched Phase 5 code" — this bug lived entirely in
  shared infrastructure (`common.error`) and was only caught because
  `AuthFlowIntegrationTest` still existed and still ran.
