# industry.md — Phase 4: how real systems solve the same problems

How the mechanisms this phase built compare to publicly documented
industry approaches to the same underlying problems. For what was
actually built and why, see `decisions.md` and `explain_verify.md` in
this folder — this file adds no new claims about this project, only
restates and compares.

---

### 1. Vendoring code across a repo boundary instead of a package or submodule

**The problem**: a piece of logic that must run identically in two
different codebases (or two different runtimes) needs to get from the
codebase that owns it into the codebase that consumes it, and stay in
sync when it changes — without either side accepting an unbounded
maintenance burden.

**How this project does it**: `verify/sync-vendor.sh` copies seven
specific paths out of the frontend repo into `verify/vendor/src/`,
preserving the frontend's own relative structure so every vendored
file's internal `@/...` import resolves unmodified via a matching
tsconfig alias. Run manually; the copied output is committed. See
`decisions.md` #1.

**Industry approaches**: this is a well-known named pattern, not a
one-off improvisation. Google publishes and uses **Copybara**
internally and as an open-source tool specifically to copy and
transform source between repositories with a repeatable script rather
than a live dependency link. Kubernetes' `client-go` and other
`k8s.io/*` libraries are generated the same way in spirit: code lives
in `kubernetes/kubernetes`'s `staging/` directory and a publishing bot
copies it out into standalone repos on a schedule. At the other end of
the spectrum, `git submodule` is the standard tool for a *live* link
to another repo's history, and is widely documented (in many
engineering blogs and Git's own docs) as easy to get wrong — detached
HEAD state, forgotten `--recurse-submodules`, CI needing extra flags.
Go's `go mod vendor` is a third variant: vendoring resolved
*dependency* code (not sibling-project code) into the consuming repo
for reproducible, network-independent builds.

**Why this project differs (or doesn't)**: this is genuinely the same
family of solution industry uses for "sync occasionally, not
continuously" — the project explicitly weighed submodule and npm
publish and picked the scripted-copy approach for the same reason
Copybara-style tooling exists: the relationship doesn't need to be
live, and a script's output is ordinary, greppable, git-blameable
source. The difference from Google/Kubernetes-scale tooling is only
one of formality: `sync-vendor.sh` is a shell script with hardcoded
paths, not a configurable transform pipeline, because there is exactly
one source repo, one destination, and one maintainer to remember to
re-run it.

**Trade-offs**:
- Gives up: automatic sync (Copybara/publishing-bot setups can run on
  a schedule or on every source-repo commit; this requires a human to
  remember and re-run the script after an engine change).
- Gains: zero infrastructure — no bot, no scheduled job, no transform
  config language to maintain, for a sync relationship that in
  practice happens rarely.
- Worth adopting scheduled/automated syncing when the source repo
  changes often enough that "someone forgot to re-vendor" becomes a
  real, recurring bug source — not a risk at a one-developer, two-repo
  scale with infrequent engine changes.

---

### 2. A stateless scoring service called synchronously over HTTP with a full-payload contract

**The problem**: when scoring/verification logic lives in a separate
process from the system of record, that process needs a request
contract that gives it everything it needs to score correctly, without
either granting it its own copy of the source-of-truth data or forcing
frequent contract renegotiation as scoring logic evolves.

**How this project does it**: `HttpVerifyClient` calls `verify/`'s
`POST /verify` synchronously, 10s timeout, no retry. The request body
is the *entire* scenario record (`{scenario, graph}`), fetched via
`scenarioService.getVersion(id, version)` — the same method the public
scenario-version endpoint uses — rather than a hand-picked subset of
fields. `verify/` holds no database connection of its own. See
`decisions.md` #3 and `explain_verify.md`.

**Industry approaches**: online code judges (Codeforces, LeetCode,
HackerRank) use the same shape at a much larger scale — a stateless
judge/execution service that receives a full submission payload and
runs it in isolation, with the platform's main database staying the
only source of truth for problem definitions. This is also the
standard "stateless service" pattern documented across microservices
literature (Chris Richardson's microservices.io catalog describes
externalizing state so a service can be scaled or restarted without
losing anything). On retries specifically, payment and scoring APIs
commonly go the *other* way from this project: Stripe's API docs
publicly recommend idempotency keys precisely so a client *can* safely
retry a timed-out request without double-processing it — the opposite
choice from this project's explicit no-retry `HttpVerifyClient`.

**Why this project differs (or doesn't)**: sending the full scenario
body instead of a curated subset is the same reasoning industry
full-payload contracts use — `decisions.md` #3 states this explicitly:
"sending the fields I think scoring needs today" risks a contract
break on every scoring refinement, so the full body is sent once and
never needs to change for that reason. The no-retry choice is the
one clear divergence from common industry practice, and it's not
disguised as anything else: Phase 3's stub had no retry either, and
this phase never revisited it — a single-attempt HTTP call is
acceptable when there's one caller, one callee, and a human watching
manual/e2e test runs, not for a payment flow at production traffic
where a dropped request has real cost.

**Trade-offs**:
- Gives up: no resilience to a transient network blip or `verify/`
  restart mid-request — a dropped connection becomes a failed
  submission with no automatic recovery, something an idempotency-key
  + retry scheme (Stripe-style) would absorb.
- Gains: no idempotency-key infrastructure, no retry/backoff logic, no
  need to make `verify()` safe to run twice for the same submission —
  meaningfully simpler code for a service with no production traffic.
- Worth adding retry-with-idempotency once `verify/` runs in an
  environment where transient failures are observed in practice (a
  real deploy target with real network variance), not before.

---

### 3. Type-only contracts erased at build time, caught by golden/fixture-parity testing

**The problem**: when two pieces of code agree on a shape only through
a compile-time type system, and that type system doesn't run at
runtime, a divergence between what one side produces and what the
other side actually reads at runtime can compile cleanly on both sides
and still be silently wrong.

**How this project does it**: `graphAdapter.ts`'s first draft built a
graph-node shape with the real entity type at the top-level `type`
field, never setting `data.entityType` — the field every scoring
function actually reads. TypeScript's structural typing didn't catch
it because `tsx` transpiles without type-checking (types are erased,
like Babel). The bug silently zeroed every submission's cost. It was
caught not by the compiler but by `verify.fixtureParity.test.ts`
asserting exact numeric equality against the real, non-vendored
engine's own output. See `decisions.md` #2 and explain_verify.md's
"What's deliberately not modeled precisely" section.

**Industry approaches**: this is precisely what **golden master /
characterization testing** (the term and technique documented by
Michael Feathers in *Working Effectively with Legacy Code*) is for —
asserting actual output against a known-correct reference rather than
asserting "this compiles" or "this matches a hand-written expectation
that could encode the same mistake." For the cross-service contract
angle specifically, **consumer-driven contract testing** (Pact is the
best-known open-source implementation) is the standard industry
pattern for catching exactly this class of drift between two services
that each compile/type-check independently but disagree on wire
shape. On the "types don't run at runtime" root cause, this is a
widely known TypeScript caveat, and the common industry mitigation is
runtime schema validation at the boundary — libraries like **Zod** or
**io-ts** are commonly reached for specifically so a payload shape is
checked when it actually crosses a process boundary, not just when it
compiles.

**Why this project differs (or doesn't)**: the fixture-parity test
*is* the golden-master pattern, deliberately — `decisions.md` #2
explicitly frames it as "exactly the class of bug a fixture-parity
test against a real reference is for." Where this project diverges
from the Zod/io-ts mitigation: `verify.ts` types `VerifyPayload.scenario`
as `Record<string, unknown>` and casts it at each call site rather than
validating it at runtime, an explicit, acknowledged gap (explain_verify.md,
"What's deliberately not modeled precisely") rather than an oversight.

**Trade-offs**:
- Gives up: no runtime guarantee that a malformed request body (a
  missing field, wrong type) fails with a clear validation error
  instead of a silent wrong answer elsewhere in the pipeline — a Zod
  schema at the `POST /verify` boundary would catch that class of
  input error before it reaches scoring logic.
  golden-master test only catches *this project's own* adapter code
  producing a wrong shape internally, not an external caller sending
  a malformed request.
- Gains: one fixture test now protects against the specific,
  historically-real bug class (structural mismatch between adapter and
  scoring logic) without adding a schema-validation dependency or
  maintaining a second, parallel description of the shape.
- Worth adding runtime validation (Zod/io-ts) if `verify/` ever gets a
  second, less-trusted caller than `api`'s own `HttpVerifyClient`, or
  if a stricter CI type-check step is added — explain_verify.md
  already flags that the `as unknown as ...` casts would need real
  attention at that point.

---

### 4. Test doubles kept test-scoped instead of shipped in production code

**The problem**: development and testing need a lightweight substitute
for a real dependency, but a substitute that ships in production
source can silently drift from what the real dependency actually does,
with nothing forcing anyone to notice.

**How this project does it**: Phase 3's `StubVerifyClient` was a
`@Component` shipped in `api`'s main source. Phase 4 deletes it;
`AttemptFlowIntegrationTest` overrides the `VerifyClient` bean with
`support.FakeVerifyClient`, which exists only under `src/test/java` and
is never shipped. See `decisions.md` #6.

**Industry approaches**: the terminology here (*stub* vs *fake* vs
*mock*) comes from Martin Fowler's widely-cited "Mocks Aren't Stubs"
article, and "don't let test doubles leak into production code" is
standard guidance from the same testing literature — the Google
Testing Blog has published repeatedly on keeping test-only code out of
production binaries, for exactly the drift risk this project names.
Spring itself supports this pattern directly: `@TestConfiguration` and
test-scoped `@Bean` overrides (as used here) are the framework's own
documented mechanism for replacing a real bean with a test double
without that double ever being a candidate for the production
application context.

**Why this project differs (or doesn't)**: this is the same industry
pattern, adopted for the same documented reason — `decisions.md` #6
states the risk plainly: a stub reachable via a profile flag is "the
kind of thing that quietly bit-rots... nobody would necessarily
notice" if `verify/`'s response format changes. No divergence here;
this section exists because it's a real, well-known trade-off worth
being explicit was actually made, not because the project did anything
unusual.

**Trade-offs**:
- Gives up: the Phase 3 convenience of running `api` locally without
  `verify/` up via a profile flag — that workflow no longer exists.
- Gains: exactly one implementation of "what does a verify response
  look like" that can ship (the real `HttpVerifyClient` against the
  real service), eliminating the class of bug where a stub and the
  real service silently disagree.
- This is a case where the industry-standard answer and this project's
  answer are the same regardless of scale — there's no volume
  threshold at which shipping a stub in production code becomes the
  better choice.

---

### 5. Layered verification: unit/fixture, HTTP smoke test, full end-to-end

**The problem**: proving a piece of business logic is correct, proving
the HTTP layer around it works, and proving two real processes agree
on the wire are three different claims — passing one doesn't imply the
others, so a single test layer leaves gaps.

**How this project does it**: three distinct checks, each catching a
different failure class: `verify.fixtureParity.test.ts` (business
logic, no HTTP, exact numeric match against the real frontend engine),
a manual `curl` smoke test against a locally-running `verify/` (HTTP
routing/parsing/error-handling), and a full `curl`-driven run through
real Spring Boot + real Postgres + real `verify/` (real network call,
timeout config, response deserialization, and cross-process agreement
on the wire contract). See `decisions.md` #5.

**Industry approaches**: this is the standard **testing pyramid**
shape (Mike Cohn's formulation in *Succeeding with Agile*, widely
taught since), and the Google Testing Blog's "test sizes" framing
(small/medium/large, corresponding roughly to unit/integration/system)
describes the same layering with the same reasoning — each size
trades speed for realism, and a suite that skips a layer has a
corresponding blind spot. At the "does a manual smoke test still
matter separately from automated e2e" layer specifically, this
mirrors how many API teams keep a lightweight `curl`/Postman smoke
check as a distinct step from both unit tests and full CI e2e suites,
precisely because it isolates HTTP-layer bugs (serialization, status
codes, header handling) from business-logic bugs.

**Why this project differs (or doesn't)**: same reasoning as industry,
stated explicitly in `decisions.md` #5: "collapsing to just one of
these would have missed something." The one place this project's
version is lighter than a typical CI pipeline is that the HTTP smoke
test is manual (`curl`, run by hand) rather than an automated step in
a pipeline — appropriate for a project with no CI/CD system standing
up `verify/` on every push, and would need to become scripted if this
became a team project with a real deploy pipeline.

**Trade-offs**:
- Gives up: the manual smoke-test layer doesn't run automatically on
  every change, so a regression there is only caught if someone
  remembers to re-run it by hand — an automated CI step wouldn't have
  this gap.
- Gains: no CI infrastructure investment for a layer that, run by
  hand, still did its job of catching the one bug class it exists for.
- Worth automating the smoke-test layer (e.g., into a CI job that
  spins up `verify/` and curls it) once there's a CI pipeline running
  regularly enough that a manual step becomes the thing that gets
  skipped under time pressure.

---

### 6. Monorepo vs. polyrepo for a polyglot backend

**The problem**: two services in different languages that call each
other over HTTP and need to evolve together need *some* repository
arrangement — a decision that's mostly orthogonal to language, runtime,
or deployability, but has real consequences for how the relationship
between the services reads to someone new to the codebase.

**How this project does it**: `api/` (Java/Spring Boot) and `verify/`
(Node/Express) live in one `engineering-studio-backend` repo as
subdirectories, each keeping its own `pom.xml`/`package.json`
untouched, with `masterdoc/` at the repo root covering both. This
reverses an earlier decision to use two separate repos. See root
`masterdoc/decisions.md` #7.

**Industry approaches**: both arrangements are real, well-documented
industry choices, not a case of one being obviously standard. Google's
monorepo is the most famous polyglot example — publicly documented in
Potvin & Levenberg's 2016 CACM paper "Why Google Stores Billions of
Lines of Code in a Single Repository," covering many languages in one
tree with per-directory ownership. Meta/Facebook runs a similarly
large polyglot monorepo (documented in their engineering blog posts on
their custom Mercurial/Sapling tooling built to make it scale). On the
other side, Amazon and Netflix are widely described (including in
Amazon's own public statements about "two-pizza teams" owning services
end-to-end) as favoring independently-owned repos per service, valuing
independent deploy cadence and team autonomy over single-tree
visibility.

**Why this project differs (or doesn't)**: the project's own stated
reasoning for choosing monorepo over polyrepo matches the small-team
end of this spectrum, not the large-org end — `masterdoc/decisions.md`
#7 is explicit that independent deployability is unaffected either way
here (both platforms considered deploy from a subdirectory just as
well as a dedicated repo), and the deciding factor was reviewer
legibility for a **solo-developer portfolio project**: one clone
showing both services and how they call each other reads better than
asking a reviewer to open two repos and infer the relationship. This
is the opposite of Amazon/Netflix's reasoning (team-autonomy at scale)
and doesn't try to claim Google/Meta's reasoning either (their tooling
solves problems — cross-language atomic commits across thousands of
engineers — this project doesn't have).

**Why this project differs (or doesn't), continued**: the cost side is
honestly named too — `decisions.md` #7 states the one real thing given
up is independent git history/tags per service, and judges it a small
cost given the project's size.

**Trade-offs**:
- Gives up: independent git history/tags per service; at real scale, a
  monorepo without Google/Meta-grade tooling (custom VCS, sparse
  checkouts, per-directory CI) would also start to hurt build/CI times
  and ownership boundaries — not a cost this project hits at two
  small services.
- Gains: one clone shows the whole backend and the relationship
  between `api` and `verify`, which is exactly the audience (a
  reviewer) this project is optimizing for.
- Worth splitting into separate repos if the two services ever gain
  separate teams, separate release cadences that a shared repo starts
  to friction against, or a CI setup where one service's build time
  starts blocking the other's unrelated changes — none of which apply
  at this project's current size.

---

## Summary

For a solo-developer project at this scale, every simplification this
phase made is the right call, not just an acceptable one. The vendoring
script, the no-retry HTTP call, the manual smoke-test layer, and the
monorepo choice all give up real things — automatic sync, resilience to
transient failure, CI-enforced regression coverage on the HTTP layer,
and independent per-service git history — but every one of those costs
is currently paid by nobody, because there's one developer, one
deploy target, and no production traffic generating the failure modes
those industry mechanisms exist to handle. The one place worth flagging
as a genuine gap rather than a comfortable trade-off is runtime payload
validation at the `POST /verify` boundary (section 3): the project
already has real, on-the-record evidence — the `fakeNode` bug — that a
type-only contract between two files can diverge silently and compile
clean on both sides, and the same class of risk exists at the network
boundary too, currently protected by nothing but a single caller
(`HttpVerifyClient`) and an honest comment. It costs little (a Zod
schema at the request boundary) and directly hardens the exact failure
mode this phase already proved is real, unlike the other trade-offs
here, which are genuinely waiting on scale that doesn't exist yet.
