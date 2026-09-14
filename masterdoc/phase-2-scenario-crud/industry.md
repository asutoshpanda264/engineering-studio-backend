# industry.md — Phase 2: Scenario CRUD + Publish Workflow + 32-Scenario Migration

How real-world systems solve the same problems this phase solved, and how
this project's approach compares. See `decisions.md` for why each choice was
made and `explain_scenario.md` for how the mechanisms actually work — this
file adds the external comparison only.

---

### 1. JSONB for semi-structured content, converted explicitly at the boundary

**The problem**: a record has a mix of stable relational fields (status,
owner, version number) and a flexible, evolving body (nested structures that
don't map cleanly to fixed columns) — a system needs to pick where the line
between "queryable schema" and "opaque blob" sits, and how data crosses it.

**How this project does it**: `topics`, `startingEntities`,
`trafficPattern`, `constraints`, `hints`, `optimalSolution`, etc. are stored
as Postgres JSONB, mapped in the `Scenario`/`ScenarioVersion` entities as
plain `String` fields — Hibernate never sees them as anything but opaque
text. All conversion to/from typed DTOs happens explicitly in
`ScenarioMapper` via a small `JsonUtil` wrapper, rather than relying on
Hibernate's built-in object↔JSON marshalling. See `decisions.md` #1/#2 and
the "JSONB fields" section of `explain_scenario.md`.

**Industry approaches**: Postgres JSONB for a flexible document-shaped body
next to indexed relational columns is a widely-used, explicitly-documented
pattern — it's the reason JSONB (binary, indexable, queryable with
operators like `@>` and GIN indexes) exists as distinct from plain `json`.
GitLab has written publicly about using JSONB columns in Postgres for
exactly this "structured core fields, flexible body" shape rather than
fully normalizing every nested attribute into its own table — a pattern
widely reused across Postgres-backed applications generally, not
something unique to one company.
The alternative some systems reach for at this same problem — storing the
whole record as a schemaless document — is MongoDB's core model; the
trade-off there is giving up relational joins/transactions across documents
for schema flexibility everywhere, not just on one field.

**Why this project differs (or doesn't)**: it doesn't differ from the
Postgres-JSONB pattern itself — the divergence is in *who* does the
JSON↔object conversion. Most Hibernate-based Spring apps let the ORM's own
`FormatMapper` handle that marshalling automatically; this project does it
explicitly, and that's a deliberate deviation driven by a real, documented
constraint: two competing Jackson major versions already coexist on this
classpath for unrelated reasons (`decisions.md` #1 cites
`phase-1-auth-rbac/explain_boot4-migration.md`), so leaving the choice of
which one marshals JSONB to framework auto-detection was judged not worth
the risk versus one explicit, deliberately-chosen conversion path.

**Trade-offs**:
- Gives up: the convenience of Hibernate automatically (de)serializing a
  JSONB column into a typed field with one annotation — every conversion
  here is a manual `JsonUtil` call in `ScenarioMapper`.
- Gains: one obvious, inspectable place where JSON conversion happens, with
  a known Jackson version, immune to ambiguity from the two Jackson majors
  present on the classpath.
- Worth revisiting if: the classpath is ever cleaned up to carry only one
  Jackson version (e.g. replacing `jjwt-jackson` with a JWT library that has
  no Jackson 2.x dependency) — at that point Hibernate's native JSON mapping
  would be safe to adopt and would remove `JsonUtil`'s manual conversion
  code entirely.

### 2. Snapshot-based content versioning (copy-on-write history)

**The problem**: a system whose content changes over time, where past
consumers (a user's completed attempt, an audit trail, a citation) need to
keep referencing exactly the version they saw, needs some way to
reconstruct historical states without keeping every version live
simultaneously.

**How this project does it**: `ScenarioService.update` snapshots the
scenario's *current* state into `scenario_versions` (tagged with its
current version number) before applying the new content and bumping the
version on the live row. `scenario_versions` therefore only ever holds past
versions; the live `scenarios` row is always current, and
`GET /scenarios/{id}/versions/{n}` falls back to the live row when `n`
equals the current version. See `decisions.md` #3/#5 and the "Versioning"
section of `explain_scenario.md`.

**Industry approaches**: this is the standard "snapshot on write" pattern
used by content-versioning systems generally. Wikipedia's revision history
works this way at the database level (each edit stores a full or diffed
past revision, with the current version always the latest row). Git itself
is the canonical example of "the current working state plus an immutable
history of prior states," though git snapshots the *whole tree* on every
commit rather than one row's field. Contentful and other headless CMSs
expose a similar "entry has a current published version plus prior version
history" model to their API consumers. The main alternative pattern, used
by systems needing to reconstruct state at *any* arbitrary point in time
rather than just named versions — event sourcing (storing every mutation as
an appended event, deriving current state by replay) — solves a more
general problem than this phase needs, at the cost of needing a projection/
read-model layer to answer "what does this look like right now" cheaply.

**Why this project differs (or doesn't)**: it doesn't differ in shape from
the standard snapshot-on-write approach; the specific engineering choice
(don't also write a snapshot for the current version, since the live row
already holds it) is a documented anti-redundancy decision, not a
simplification of the pattern itself (`decisions.md` #5: "extra writes/rows
to keep in sync for zero benefit").

**Trade-offs**:
- Gives up: nothing meaningful at this scale — the one-`if`-statement
  fallback for the current version is strictly simpler than event sourcing
  or a always-snapshot approach, with identical observable behavior for
  every version number a caller can ask for.
- Gains: exactly one snapshot write per edit (not per read, not a
  redundant one for "now"), and a single query path
  (`GET /scenarios/{id}/versions/{n}`) that works uniformly for past and
  current versions.
- Worth revisiting if: a feature needs diffing between arbitrary versions,
  or reconstructing state at an arbitrary point in time rather than a named
  version number — that's where event sourcing's finer granularity would
  start to earn its complexity, which nothing in this project currently
  needs (an `Attempt`, per `explain_scenario.md`, only ever needs "the exact
  version I solved," a single named snapshot).

### 3. Draft → review → publish workflow gated by role and ownership

**The problem**: a system that lets multiple contributors create content,
but wants a review step before that content goes live, needs to encode
"who can move this content from private/editable to public" as an explicit,
enforced workflow rather than an informal convention.

**How this project does it**: a scenario is created as `DRAFT` by its
creator, moves to `PUBLISHED` only via an admin-only `POST
/scenarios/{id}/publish` call, and a contributor can edit their own scenario
only while it's still `DRAFT` — after publish, only an admin can edit it
(`decisions.md` #4, the state-machine diagram in `explain_scenario.md`).

**Industry approaches**: draft/review/publish as an explicit editorial state
machine is the standard shape of every mainstream CMS — WordPress's
post-status model (`draft` → `pending review` → `publish`), Contentful's and
Sanity's entry-status model, and Git-based static-site workflows where a PR
review gate stands in for the same "someone other than the author signs off
before it's live" requirement. The common industry variation on top of this
project's two-state model is a dedicated `PENDING_REVIEW` (or "in review")
status distinct from `DRAFT`, so a submission is visibly queued for review
rather than the reviewer needing to separately discover which drafts are
ready.

**Why this project differs (or doesn't)**: it's the same pattern with one
fewer explicit state (no separate "submitted for review" status — a
contributor's draft is directly publishable by any admin who finds it via
`GET /scenarios/drafts`). This matches the actual scale described in
`README.md`/`decisions.md`: a small, known set of contributors and admins,
not a submission queue with enough volume to need its own visible state.

**Trade-offs**:
- Gives up: no visible signal that a contributor considers a draft "ready
  for review" versus still work-in-progress — an admin has to use judgment
  (or out-of-band communication) about which drafts in the flat
  `/scenarios/drafts` list are actually finished.
- Gains: one fewer state to model, transition, and test — the whole
  workflow is two admin-gated transitions (`publish`, `archive`) plus one
  ownership-gated edit rule, with no separate "submit for review" endpoint
  or status.
- Worth revisiting if: the number of contributors or draft volume grows
  enough that admins need a real review queue distinct from "everything not
  yet published" — at that point a `PENDING_REVIEW` status (and a
  contributor-facing "submit" action) becomes worth the added state.

### 4. Archive instead of delete for live/historical content

**The problem**: removing a piece of content that other records (a
completed transaction, a user's history, an analytics event) already
reference by id breaks anything that later needs to look that reference up
— a system needs a way to stop showing something without destroying what
depends on it.

**How this project does it**: `POST /scenarios/{id}/archive` (admin-only,
`PUBLISHED → ARCHIVED`) removes a scenario from `GET /scenarios` but leaves
the row (and every `Attempt`/`ProblemProgress` that references it) intact.
Hard `DELETE` is only permitted while a scenario is still `DRAFT` — a 409
otherwise, with the response telling the caller to archive instead. See the
state-machine section of `explain_scenario.md`.

**Industry approaches**: this is the standard "soft delete" pattern —
adding a status/flag (or a `deleted_at` timestamp) rather than removing the
row — used throughout e-commerce (a discontinued product stays fetchable by
id for past order history; Shopify and Stripe both keep deprecated/archived
objects retrievable by id rather than deleting them) and content platforms
generally. Stripe's API explicitly documents this: objects like prices and
products can be archived (no longer usable in new operations) but remain
permanently retrievable, specifically so past invoices/charges that
reference them keep resolving correctly.

**Why this project differs (or doesn't)**: it doesn't differ — this is the
same reasoning Stripe documents publicly, applied at this project's own
scale: `explain_scenario.md` states directly that archiving "doesn't delete
anything," precisely so an `Attempt`'s historical reference to a scenario
(and that scenario's specific version, per mechanism #2 above) never breaks.

**Trade-offs**:
- Gives up: nothing structural — this is not a simplified version of the
  industry pattern, it's the same pattern. The only real cost is one extra
  status value and a filter (`WHERE status != 'ARCHIVED'`) on every public
  listing query, forever.
- Gains: no separate hard-delete/tombstone/cascade-handling logic to write,
  and referential integrity for historical `Attempt`/`ProblemProgress` rows
  is automatic rather than something to defend against.
- Worth revisiting if: never, structurally — the only plausible change at
  larger scale is moving genuinely ancient archived rows to cold storage for
  cost reasons, which is an infrastructure concern, not a change to the
  archive-don't-delete policy itself.

### 5. 401 vs. 403 as distinct, deliberate signals

**The problem**: a client (particularly a frontend) needs to distinguish
"you're not logged in, go log in" from "you're logged in, but this isn't
for you" to decide whether to redirect to a login screen or show a
permissions error — collapsing both into one status code forces the client
to guess.

**How this project does it**: `SecurityConfig` wires an explicit
`HttpStatusEntryPoint(HttpStatus.UNAUTHORIZED)`, found via a real test
failure (`GET /scenarios/drafts` with no token was returning 403, not 401,
under Spring Security's default `Http403ForbiddenEntryPoint`). This leaves
`@PreAuthorize`'s correct-by-default 403 behavior untouched for
authenticated-but-wrong-role cases. See `decisions.md` #7.

**Industry approaches**: RFC 7235/7231 define exactly this split — 401
means "no valid credentials, authenticate first," 403 means "credentials
were fine, you still can't do this" — and it's echoed in most public API
documentation (Stripe, GitHub, Google Cloud APIs all document the same
distinction). GitHub's API is a well-known, publicly documented exception
worth naming: it deliberately returns 404 (not 403) for a private
repository a token isn't authorized to see, specifically to avoid
confirming the resource exists at all to an unauthorized caller — a
resource-existence-leak trade-off this project's endpoints don't need to
worry about, since scenario ids aren't treated as sensitive.

**Why this project differs (or doesn't)**: it doesn't differ from the
RFC-standard 401/403 split — Spring Security's own default just happens not
to implement that split out of the box without an explicit
`AuthenticationEntryPoint`, which is what this fix supplies.

**Trade-offs**:
- Gives up: nothing versus the standard approach — this is closing a gap
  from a framework default, not a simplification with a real cost.
- Gains: correct, spec-aligned client behavior (a frontend can reliably
  redirect-to-login on 401 vs. show a permissions error on 403) for the
  cost of one line of `SecurityConfig`.
- Worth revisiting if: a future endpoint needs GitHub's stronger
  existence-hiding behavior (e.g. a scenario a contributor shouldn't even
  know exists) — not currently a requirement anywhere in this project's
  RBAC rules.

### 6. Seed data as a versioned, committed migration

**The problem**: every environment a system runs in (local dev, CI, a real
deploy) needs to start from the same baseline data, without a manual,
easy-to-forget "remember to load the seed data" step living outside version
control.

**How this project does it**: `V2.1__seed_scenarios.sql` is a committed
Flyway migration containing 32 literal `INSERT ... ON CONFLICT (id) DO
NOTHING` statements, generated once from the frontend's real `SCENARIOS`
array by a throwaway extraction script plus a committed generator
(`tools/migrate-scenarios/generate-seed-sql.js`). Every environment that
runs migrations ends up with the identical 32 scenarios automatically. See
`decisions.md` #9 and the "32-scenario seed" section of `explain_scenario.md`.

**Industry approaches**: versioned seed migrations are one of two common
patterns. Rails' `db/seeds.rb` and Django's fixture-loading are the
alternative: a separate, explicitly-invoked seeding step outside the normal
migration history, run by a developer or a deploy script rather than
happening automatically as schema migrations apply. Putting seed data
*inside* the same migration tool's version history (what this project does,
via Flyway) is also a widely-used pattern precisely because it removes that
separate manual step — Flyway's and Liquibase's own documentation both
describe versioned reference/seed data as a legitimate use of a numbered
migration file, not just schema DDL.

**Why this project differs (or doesn't)**: it doesn't differ — putting seed
data in the migration history rather than a separate seed script is a
standard, documented choice within the Flyway ecosystem this project
already committed to (`masterdoc/decisions.md`'s Flyway choice), made here
specifically so a fresh Testcontainers instance in CI and a real deploy
target both get the same 32 scenarios with zero extra steps.

**Trade-offs**:
- Gives up: a `db/seeds.rb`-style script's flexibility (conditional seeding,
  environment-specific data, re-runnable idempotent logic beyond
  `ON CONFLICT DO NOTHING`) — this project's seed data is fixed 32 rows,
  not development-only or environment-varying fixtures.
- Gains: zero-step reproducibility — no environment can end up missing the
  seed data or running it twice, since it's just another migration Flyway
  already tracks having applied.
- Worth revisiting if: seed data needs to differ by environment (e.g. a
  much larger synthetic dataset for load-testing, absent in production) —
  that's the point a separate seeding mechanism outside the migration
  history would stop fighting Flyway's "same schema history everywhere"
  guarantee.

---

## Summary

For a project with a handful of contributors, one admin flow, and no real
review-queue volume, every mechanism in this phase is either the direct
industry-standard pattern (JSONB for flexible content, snapshot-based
versioning, archive-not-delete, the 401/403 split, seed data as versioned
migrations) or a deliberately smaller version of one (a two-state draft/
publish workflow instead of a three-state one with an explicit review
queue). None of these are gaps to flag — the one place a real system at
larger scale would clearly do more (a visible "submitted for review" state
distinct from a general draft pile) is a genuine known limitation, but an
honest and correctly-scoped one: `decisions.md` and `explain_scenario.md`
both describe the current two-state model as sufficient for the number of
contributors this project actually has, not as an oversight.
