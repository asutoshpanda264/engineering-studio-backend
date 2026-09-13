# industry.md — Phase 3: Attempt State Machine (Verify Stubbed)

How real-world systems solve the same problems this phase solved, and how
this project's approach compares. See `decisions.md` for why each choice was
made and `explain_attempt.md` for how the mechanisms actually work — this
file adds the external comparison only.

---

### 1. Server-authoritative elapsed time, never a client-reported duration

**The problem**: a system that measures how long something took (for
scoring, billing, or fairness) needs the number to come from a source the
client can't manipulate — a client-reported duration can always be
falsified or corrupted by clock skew, background-tabbing, or a crashed
timer.

**How this project does it**: `elapsedSeconds` is computed entirely from
server-recorded `Instant`s (`startedAt`, `pausedAt`/`resumedAt` per pause
interval, `submittedAt`) drawn from an injected `Clock` bean, never from
anything the client sends — `(submittedAt − startedAt) − totalPausedSeconds`,
floored at 0. See `explain_attempt.md`'s "elapsed-time calculation" section
and `decisions.md` #2.

**Industry approaches**: "the server is authoritative, the client is only a
display/input surface" is the standard model in online multiplayer games —
widely taught as server-authoritative simulation with client-side
prediction (documented in Valve's Source Engine networking docs and
repeated across game-networking literature) specifically so a modified
client can't fake its own state. Ride-hailing fare calculation is a
non-gaming example of the same principle: trip duration/distance used for
billing is derived from the platform's own server-side location pings, not
a number the rider's or driver's app self-reports. Cloud billing systems
(AWS, GCP) work the same way — usage is metered server-side from the
provider's own infrastructure, never from client-submitted totals.

**Why this project differs (or doesn't)**: it doesn't differ — this is the
same principle, applied at a much smaller scale (one `Clock` bean and a
handful of timestamp columns, not a real-time simulation or a metering
pipeline). The reasoning is identical to why those systems do it: `decisions.md`
#2 exists specifically because trusting anything client-reported for a
score-affecting number is a correctness and fairness gap, not a style choice.

**Trade-offs**:
- Gives up: nothing structural versus the industry pattern — the underlying
  principle (never trust the client for a number that affects scoring) is
  identical.
- Gains: the same integrity guarantee as a game or billing system, at a
  fraction of the machinery — one `Clock` bean and column reads, no
  real-time state synchronization, no telemetry pipeline.
- Worth revisiting if: never, on the core principle. What *would* need to
  grow is precision/robustness — e.g. handling a server restart mid-attempt,
  or attempts spanning a daylight-saving/leap-second boundary — none of
  which this project's scale has hit yet.

### 2. An explicit finite state machine for a multi-step stateful workflow

**The problem**: a resource that moves through several distinct stages over
time, where only certain transitions are valid from each stage, needs those
states and transitions made explicit and enforced — otherwise "what can
happen next" becomes an unwritten rule scattered across conditionals.

**How this project does it**: `AttemptStatus` is a closed set of five
values — `IN_PROGRESS`, `PAUSED`, `SUBMITTED`, `VERIFY_FAILED`, and
`EXPIRED` — though only the first four are actually reachable today.
The legal transitions between the reachable four are drawn out as a
diagram in `explain_attempt.md`'s "The state machine" section and
enforced by `AttemptService`'s per-method checks (e.g. `pause` rejects a `NO_PRESSURE` attempt, `submit`
rejects an already-`SUBMITTED` one). `SUBMITTED` is terminal;
`VERIFY_FAILED` is the one state that loops back rather than
dead-ending. `EXPIRED` is a fifth, currently-dormant value: `submit`
defensively checks for and rejects it (`explain_attempt.md`'s "What
submit actually does" step 1), but nothing in this codebase ever sets an
attempt to `EXPIRED` yet — it's reserved for a not-yet-built expiry
feature, not a reachable state in the diagram above.

**Industry approaches**: explicit state machines for a resource's lifecycle
are standard across payment and order systems. Stripe's `PaymentIntent`
publicly documents exactly this shape — a fixed set of statuses
(`requires_payment_method`, `requires_confirmation`, `processing`,
`succeeded`, and terminal/failure states) with documented legal transitions
between them, including a "failed but can retry" state that mirrors this
project's `VERIFY_FAILED`. E-commerce order-status models (an order moving
through `pending` → `paid` → `fulfilled` → `cancelled`) follow the same
pattern, as does AWS Step Functions, which makes the state-machine itself a
first-class, visually-diagrammed artifact rather than implicit code.

**Why this project differs (or doesn't)**: it doesn't differ in shape — a
small, closed set of statuses with explicit legal transitions is the same
approach Stripe and order-management systems use. The scale differs: this
project's state machine lives entirely in `AttemptService`'s per-method
guard clauses rather than a dedicated state-machine library or framework,
because four states and a handful of transitions don't yet justify one.

**Trade-offs**:
- Gives up: no single source of truth a tool can visualize or validate
  automatically (a state-machine library would let invalid transitions be
  caught by a shared engine rather than scattered guard clauses per method);
  no built-in audit log of every transition (though `attempt_pause_intervals`
  does audit pause/resume specifically, per `explain_attempt.md`).
- Gains: four states and their transitions are simple enough to read
  directly off one diagram in `explain_attempt.md` and verify by inspection
  — no state-machine framework/DSL to learn or debug for a workflow this
  small.
- Worth revisiting if: the number of states or transition rules grows enough
  that guard-clause-per-method stops being easy to audit by eye (e.g. if a
  future phase adds more failure/retry states with their own sub-rules) —
  that's the point a real state-machine library would start paying for
  itself.

### 3. A stubbed interface seam before the real external integration exists

**The problem**: building a feature that depends on another service (one
that doesn't exist yet, or is unreliable to develop against) needs some way
to make forward progress and prove the dependent logic correct without
waiting on, or coupling tightly to, that external service.

**How this project does it**: `AttemptService` depends only on the
`VerifyClient` interface; `StubVerifyClient` is the only implementation in
this phase, replaced by a real HTTP-calling implementation in Phase 4
without `AttemptService` itself changing. See `decisions.md` #1.

**Industry approaches**: this is the standard Ports and Adapters (hexagonal
architecture) pattern — Alistair Cockburn's original description names
exactly this benefit, swapping a fake adapter for a real one behind a fixed
interface. It's also the core idea behind Martin Fowler's widely-referenced
"TestDouble" family of patterns (stubs/fakes/mocks) and the "walking
skeleton" practice described in *Growing Object-Oriented Software, Guided
by Tests* — get an end-to-end path working against fakes first, then
replace pieces with real implementations one at a time. Stripe's own public
API offers a directly comparable product-level version: a documented test
mode that returns canned, deterministic responses (including specific
card numbers that always trigger a decline) so integrators can build
against realistic failure paths before touching a real payment network.

**Why this project differs (or doesn't)**: it doesn't differ — this is the
textbook version of the pattern, and `decisions.md` #1 states the reasoning
explicitly: prove the state machine correct in isolation now, so Phase 4 is
"swap one Spring bean" rather than debugging the state machine and a new
HTTP integration simultaneously.

**Trade-offs**:
- Gives up: nothing versus the pattern itself — there's no simplification
  here, this project used the standard technique for the standard reason.
- Gains: the entire Phase 3 test suite (`AttemptFlowIntegrationTest`, 7/7)
  runs with zero dependency on `engineering-studio-verify` existing,
  including its one forced-failure case for testing `VERIFY_FAILED` — a
  scenario that would otherwise require the real service to expose a
  deliberate way to fail on demand.
- Worth revisiting if: never, structurally — the seam's whole purpose was to
  be swapped out, and Phase 4 already did that (`HttpVerifyClient` exists
  alongside `StubVerifyClient` in the current codebase).

### 4. Keeping an external call outside the transaction that records its outcome

**The problem**: a workflow that calls an external service and then must
durably record whichever outcome comes back — success or failure — needs
the failure-recording write to survive even though the call it's recording
the failure *of* just failed; wrapping the whole thing in one transaction
risks the failure-status write being rolled back along with everything else.

**How this project does it**: `AttemptService.submit` itself isn't
`@Transactional` — it calls `VerifyClient.verify(...)` unguarded by any
transaction, then routes to one of two independent `@Transactional` methods
on a separate bean, `AttemptFinalizer` (`finalizeVerified` or
`markVerifyFailed`), so a Spring self-invocation proxy gap can't silently
merge what look like two transaction boundaries into one. See `decisions.md`
#3.

**Industry approaches**: this is a smaller-scale instance of two related,
well-documented microservice patterns. The Saga pattern (documented on
Chris Richardson's microservices.io and widely taught for distributed
transactions) solves the general version of this problem: a sequence of
local transactions with explicit compensating actions when a step fails,
specifically because no single ACID transaction can span an external call.
The Transactional Outbox pattern addresses the related "don't lose the
outcome of a side effect" problem by writing the intended action and its
result to a local table within the same transaction as the state change,
rather than trusting an in-flight call. Payment processing generally follows
the same shape this project does: call the external gateway first (outside
any local transaction), then write the result (charged, declined, or
failed) as a separate, subsequent local write.

**Why this project differs (or doesn't)**: it doesn't differ in principle —
same reasoning as a Saga's per-step boundary or a payment gateway's
"call first, then record" order. It's simpler than a real Saga because
there's only one external call and one local outcome write, with no
multi-step compensating-transaction chain to define; a full Saga
implementation (with a coordinator, or choreographed compensating events
across services) would be solving a harder problem — coordinating rollback
across *multiple* services — that this single-call, single-service case
doesn't have.

**Trade-offs**:
- Gives up: no generalized compensation mechanism — if this project someday
  chains multiple external calls in one workflow (e.g. verify, then award
  points, then update a leaderboard, each a separate service), it doesn't
  yet have a reusable pattern for "one step failed after two already
  succeeded" the way a real Saga coordinator would.
- Gains: the exact correctness guarantee needed today (a verify failure
  reliably lands in `VERIFY_FAILED`) with two plain `@Transactional` methods
  on one extra bean — no message broker, no saga coordinator, no
  compensating-transaction bookkeeping.
- Worth revisiting if: a future phase chains multiple external calls/side
  effects in sequence where a partial failure needs to undo earlier steps,
  not just record its own outcome — that's a real Saga's actual problem,
  and this project doesn't have it yet with a single verify call.

### 5. A failure state that's resubmittable without resetting prior progress

**The problem**: when an operation can fail transiently (a timeout, a
downstream 5xx) rather than because the request itself was invalid, a
system needs to let the caller retry without discarding correct state that
was already established before the failure.

**How this project does it**: `markVerifyFailed` touches only `status`;
`startedAt`/`pausedAt`/`totalPausedSeconds` are left untouched, so a
resubmit recomputes elapsed time from the real, unmodified history —
including a pause that was still open at the moment of failure, which the
elapsed-time calculation detects via `pausedAt != null` rather than the
`status` field. See `decisions.md` #4.

**Industry approaches**: this is the same principle behind idempotency keys
in payment APIs — Stripe's publicly documented `Idempotency-Key` header
lets a client safely retry a request that may have failed in transit
without double-charging or losing the original request's context, because
the retry reuses the same underlying operation rather than starting a
"clean" one. Job queue systems (AWS SQS's visibility timeout, Sidekiq's
retry semantics) follow the same shape at the infrastructure level: a job
that fails or times out becomes eligible for reprocessing without losing
its original payload or context, rather than being silently reset or
discarded.

**Why this project differs (or doesn't)**: it doesn't differ in principle —
preserving prior state through a failure so a retry works correctly instead
of forcing a synthetic "clean slate" is the same reasoning Stripe's
idempotency design and job-queue retry semantics both rely on. `decisions.md`
#4 states the reasoning directly: nothing was computed or awarded on
failure, so there is nothing that needs undoing.

**Trade-offs**:
- Gives up: nothing versus the pattern — this isn't a scaled-down version,
  it's the same approach (preserve state, allow retry) applied to one
  attempt's timing fields instead of a payment or a queued job.
- Gains: a resubmit "just works" with the existing elapsed-time calculation,
  no separate retry-reconciliation code path needed.
- Worth revisiting if: a future phase adds a genuinely retryable side effect
  with its own idempotency risk (e.g. points awarded on verify success, if a
  retry could double-award) — Phase 5 onward needs to check that whatever it
  writes on success is itself safe to compute exactly once, the same
  vigilance an idempotency key protects against on the payment side.

### 6. No lock or uniqueness guard against concurrent duplicate attempts

**The problem**: when a user could plausibly start two overlapping units of
work against the same resource (two browser tabs, a double-click, a retried
request), a system has to decide whether to actively prevent that
overlap or simply allow it and let downstream logic cope.

**How this project does it**: `POST /attempts` doesn't check for an
existing `IN_PROGRESS`/`PAUSED` attempt on the same scenario before creating
a new one — multiple concurrent attempts are allowed, as a deliberate,
named scope cut. See `decisions.md` #5.

**Industry approaches**: systems that need to prevent this outright
typically use either a database uniqueness constraint (a partial unique
index scoped to the "open" states, comparable in shape to this project's own
`idx_attempts_user_status_open` index — except used as a hard constraint
rather than just a query accelerator) or a short-lived distributed lock
(e.g. a Redis lock keyed by user+resource) held for the duration of the
active session. Competitive-programming and assessment platforms — the
closest product category to this one — commonly do restrict a user to one
active attempt per problem at a time, precisely because a second concurrent
attempt is a source of confusion (which one's time counts?) rather than a
legitimate use case. High-demand seat/ticket reservation systems solve a
harder version of the same problem (many users racing for the same limited
resource) with either pessimistic row locks or optimistic
compare-and-swap writes at the database level.

**Why this project differs (or doesn't)**: this is a real, named gap versus
what a comparable assessment platform typically enforces — `decisions.md`
#5 is explicit that this was deferred because the frontend's own UI (one
canvas, one active session) makes a second concurrent attempt from the
*normal* client an unreachable path, not because the underlying race
doesn't exist at the API/database level. It's a product-surface argument,
not a claim that the API itself prevents the duplicate.

**Trade-offs**:
- Gives up: no server-side guarantee against two concurrent attempts on the
  same scenario — a user with two open tabs, or two direct API calls, can
  create two live `IN_PROGRESS` rows today, each accumulating its own
  independent elapsed time.
- Gains: no extra query on the hot `start` path, no lock contention or
  extra failure mode (e.g. "attempt already in progress" 409) to design and
  test for a scenario the primary client can't currently trigger.
- Worth revisiting if: a real duplicate-attempt incident actually occurs
  (a user opening two tabs, or a retried request creating a second row) — at
  that point the fix is cheap: turn the existing
  `idx_attempts_user_status_open` partial index into a genuine unique
  constraint, or check it before insert, rather than introducing a
  distributed lock this project's single-instance scale doesn't need.

---

## Summary

Most of this phase is the direct industry pattern, not a simplified stand-in
for one: server-authoritative timing, a stubbed interface seam before the
real dependency exists, and preserving state through a resubmittable
failure all match how games, payment platforms, and job queues solve the
same problems, for the same reasons, just at far smaller scale (a `Clock`
bean and two Spring beans, not a simulation engine or a message broker). The
finite-state-machine and split-transaction mechanisms are also the standard
shape, deliberately implemented as guard clauses and two `@Transactional`
methods rather than a state-machine library or a full Saga — correctly
scoped down given four states and one external call. The one genuine,
named gap is the missing concurrent-attempt guard (`decisions.md` #5):
unlike a typical assessment platform, nothing at the API or database layer
stops two overlapping attempts on the same scenario — it's currently masked
by the frontend's single-canvas UI rather than actually closed, and is
worth fixing with a cheap unique-constraint change the moment it's ever
observed as a real problem rather than a theoretical one.
