# industry.md — Phase 1: Auth & RBAC

How real-world systems solve the same problems this phase solved, and how
this project's approach compares. See `decisions.md` for why each choice was
made and `explain_auth.md`/`explain_boot4-migration.md` for how the
mechanisms actually work — this file adds the external comparison only.

---

### 1. Token strategy: stateless JWT access tokens + opaque DB-backed refresh tokens

**The problem**: a system needs to authenticate every incoming request
without either (a) hitting a database on every single request, or (b)
issuing a long-lived credential that can never be revoked before it expires.

**How this project does it**: a short-lived (15 min) signed JWT carries
`sub` (userId) and `role`, verified by signature alone with no DB lookup —
this is the access token. A long-lived (30 days) refresh token is a random
32-byte value, not a JWT, hashed and stored in Postgres, checked against the
database (including `revokedAt`) on every use. See `decisions.md` #1 and #3,
and the "two kinds of token" section of `explain_auth.md`.

**Industry approaches**: this exact split — short-lived stateless JWT plus
a long-lived, database-checked opaque or hashed refresh token — is the
standard pattern described in Auth0's and Okta's own documentation on
refresh token usage, and is the model OAuth2's access-token/refresh-token
split was built around from the start (RFC 6749). Some systems go further
and make the access token itself opaque too, always hitting a shared session
store (e.g. session tokens validated against Redis, the pattern used by
many session-based web frameworks) — trading the JWT's "no DB hit" property
for instant revocability on every token, not just the refresh token.

**Why this project differs (or doesn't)**: it doesn't differ — this is the
same industry-standard split, for the same stated reason (see
`decisions.md` #1's "Scenario it covers": stateless verification without a
shared session store, with revocation only where it's actually needed).

**Trade-offs**:
- Gives up: instant revocation of an access token — a stolen JWT is valid
  for up to 15 minutes no matter what the server does in the meantime.
- Gains: zero DB round-trips to authenticate the large majority of requests,
  and no shared session-store infrastructure needed to horizontally scale
  the API.
- Worth revisiting if: a real security incident requires killing an
  access token mid-flight (not just refresh tokens) — at that point a
  short-TTL denylist (checked against Redis, similar to how revocation
  already works for refresh tokens in a later phase) becomes worth the
  added lookup.

### 2. Refresh token rotation for theft detection

**The problem**: a long-lived credential that can be replayed indefinitely
turns any leak (a logged device, an intercepted request, a stolen cookie)
into silent, undetectable compromise for as long as it remains valid.

**How this project does it**: every `/auth/refresh` call revokes the
presented token and issues a brand-new refresh token alongside the new
access token — a token can only ever be used once. See `decisions.md` #4
and the "Refresh" step in `explain_auth.md`.

**Industry approaches**: this is "refresh token rotation," documented as
the recommended practice by Auth0 and by the OAuth 2.0 Security Best
Current Practice draft (RFC 9700's predecessor drafts). The stronger
version some identity providers implement — Auth0's "refresh token reuse
detection" — goes one step further: if a *already-rotated* (dead) token is
ever presented again, the whole token family is revoked immediately,
because reuse of a dead token is itself the theft signal, not just something
inferred later. Google's OAuth refresh tokens similarly can be invalidated
server-side, though Google does not rotate on every use by default for all
client types.

**Why this project differs (or doesn't)**: it implements the same base
rotation mechanism as the industry standard practice, but not the stronger
reuse-detection variant — reusing a dead token here is simply rejected as
invalid, the same as any other invalid token, rather than triggering an
active revoke-the-whole-family response. This matches the scale: with no
real attacker traffic to defend against, the detectable-on-next-use property
`decisions.md` #4 describes is already the useful part.

**Trade-offs**:
- Gives up: no automatic "kill every session" response the instant reuse of
  a dead refresh token is detected — the compromised token is simply denied,
  but a *legitimate* user still has to notice their session broke and
  re-login; other sessions from the same original leak aren't proactively
  torn down.
- Gains: the entire mechanism is a boolean check-and-revoke against one
  table, no token-family graph to track or reason about.
- Worth revisiting if: this API ever handles real adversarial traffic (a
  public product with real attackers, not a portfolio demo) — reuse
  detection is a small addition once rotation already exists, and closes a
  real gap.

### 3. Claims-based RBAC with method-level authorization

**The problem**: a system with more than one class of user needs to check
"is this specific user allowed to call this specific operation," cheaply,
on every request, without re-deriving the answer from scratch each time.

**How this project does it**: role (`ADMIN`/`CONTRIBUTOR`/`USER`) is baked
into the JWT as a claim at issuance, turned into a Spring Security granted
authority by `JwtAuthFilter` on every request, then checked two ways: coarse
path rules in `SecurityConfig` (public vs. must-be-authenticated), and
fine-grained `@PreAuthorize("hasRole('ADMIN')")` on individual controller
methods, proven end-to-end by the `GET /admin/ping` smoke test. See
`explain_auth.md`'s "RBAC enforcement" section and README.md.

**Industry approaches**: claims-based RBAC embedded in the access token is
the standard shape of OAuth2/OIDC-based authorization — Auth0 and Okta both
document putting roles/permissions into custom JWT claims and checking them
API-side per request, exactly to avoid a DB lookup for authorization on
every call. Method-level declarative authorization is the same idea Spring
Security's own `@PreAuthorize` was built for, and the same pattern shows up
as decorators/middleware in other stacks (`@Roles(...)` in NestJS,
`before_action` role filters in Rails). Systems with much larger permission
surfaces (many resource types, per-object permissions) typically move past
role-only checks to attribute- or relationship-based access control — AWS
IAM policies and Google's Zanzibar-style relationship-based authorization
(used internally at Google and the model behind tools like Ory Keto and
Auth0 FGA) are the well-known examples once "one of three fixed roles"
stops being expressive enough.

**Why this project differs (or doesn't)**: it doesn't differ in mechanism —
claims-in-token plus declarative per-method checks is the standard approach
at this problem's actual shape (three fixed roles, no per-resource
permissions yet). The stale-claim trade-off below is accepted deliberately,
not overlooked: `explain_auth.md`'s testing section explicitly proves and
documents that a promoted user's *existing* token keeps its old role until
it expires or is refreshed.

**Trade-offs**:
- Gives up: real-time correctness — a role change (promotion/demotion)
  doesn't take effect until the user's current access token expires (≤15
  min) or they refresh, because the role is fixed into the JWT at issuance.
- Gains: zero-DB-hit authorization checks on every request; no permissions
  table or policy engine to maintain for a 3-role system.
- Worth revisiting if: roles stop being a small fixed enum (e.g. per-scenario
  ownership, per-team permissions) — that's the point where a relationship-
  or attribute-based model earns its complexity, not before.

### 4. Password storage with bcrypt

**The problem**: a system that authenticates with passwords must store them
such that a database leak doesn't hand out plaintext (or cheaply-crackable)
credentials.

**How this project does it**: passwords are hashed with BCrypt
(`PasswordEncoder`) before storage and checked with
`passwordEncoder.matches(...)` at login; BCrypt manages its own per-hash
salt automatically, so no salt is generated or stored separately. See the
"Registration" and "Login" sections of `explain_auth.md`.

**Industry approaches**: bcrypt is one of a small set of industry-standard
password hashing algorithms, alongside Argon2 (winner of the 2015 Password
Hashing Competition, now OWASP's top recommendation) and scrypt. OWASP's
Password Storage Cheat Sheet currently recommends Argon2id first, with
bcrypt as an acceptable, widely-deployed alternative — both share the same
key property plain SHA-256 lacks: they're deliberately slow and
memory/CPU-tunable, making brute-forcing a leaked hash database expensive
even at scale.

**Why this project differs (or doesn't)**: effectively the same category of
solution as current best practice, one specific algorithm choice behind the
current OWASP top pick. Spring Security ships `BCryptPasswordEncoder` as
its default `PasswordEncoder`, which is almost certainly why it's the one
in use here rather than a deliberate bcrypt-over-Argon2 evaluation recorded
in `decisions.md`.

**Trade-offs**:
- Gives up: Argon2's stronger, more configurable memory-hardness against
  GPU/ASIC cracking attempts at very large leaked-database scale.
- Gains: bcrypt is the Spring Security default, requires zero extra
  dependency or configuration, and is still considered acceptable (not
  deprecated) by OWASP today.
- Worth revisiting if: a security audit or compliance requirement
  specifically calls for Argon2 — for a 3-role portfolio-scale system with
  no real breach history, bcrypt is not a gap worth closing preemptively.

### 5. Hand-rolled stateless authentication vs. framework `AuthenticationManager`

**The problem**: a framework offering a general-purpose authentication
pipeline (built for session/form login, SSO, multiple credential sources)
has to be adopted, adapted, or bypassed by any app whose actual auth flow
doesn't match that shape.

**How this project does it**: `AuthService.login` checks the password
directly against the looked-up `User` row, with no `UserDetailsService`,
`DaoAuthenticationProvider`, or `AuthenticationManager` in the picture.
Every *subsequent* request is authenticated by `JwtAuthFilter` reading the
token directly, not by Spring Security's own authentication pipeline. See
`decisions.md` #5.

**Industry approaches**: Spring's own reference documentation and most
Spring Security JWT tutorials (Baeldung's widely-referenced JWT guide among
them) do wire a `UserDetailsService` and `AuthenticationManager` even for
token-based APIs, treating it as the idiomatic Spring Security shape
regardless of session vs. token use. Other ecosystems solve the same
"pluggable authentication sources" problem differently — Passport.js in
Node treats every auth method (local password, OAuth, JWT) as an
interchangeable "strategy" behind one common interface, which is the same
generality Spring's `AuthenticationManager`/`AuthenticationProvider` design
is aiming for.

**Why this project differs (or doesn't)**: a deliberate simplicity choice,
documented in `decisions.md` #5 — the framework machinery exists to let
Spring Security itself decide "is this request authenticated," which only
matters when authentication can happen through multiple interchangeable
providers or needs to populate the `SecurityContext` automatically per
request. This app authenticates at exactly two explicit call sites
(`/auth/login`, `/auth/refresh`) and nowhere else, so the adapter layer
would sit unused.

**Trade-offs**:
- Gives up: pluggability — adding a second credential source later (OAuth
  login via Google, an API key for service-to-service calls) means writing
  a second explicit path, not registering a new `AuthenticationProvider`
  into an existing pipeline.
- Gains: one obvious place (`AuthService`) to read to understand the entire
  login flow, with no unused framework beans and no indirection between
  "password check happens" and "where that code lives."
- Worth revisiting if: a second real authentication method needs to be
  supported (SSO, API keys, OAuth social login) — that's the point where a
  common `AuthenticationProvider` abstraction starts pulling its weight
  instead of adding indirection for its own sake.

### 6. UUID primary keys generated in application code vs. database-side generation

**The problem**: every row needs a unique identifier, chosen by something —
the database, the application, or a dedicated ID-generation service — and
that choice affects portability, collision risk, and (at scale) contention.

**How this project does it**: `@GeneratedValue(strategy = GenerationType.UUID)`
on every entity — Hibernate generates a random UUIDv4 in application code
before the INSERT; the Postgres column is a plain `UUID PRIMARY KEY` with no
`DEFAULT`. See `decisions.md` #2.

**Industry approaches**: UUIDv4 generation (client-side or DB-side via
Postgres's `pgcrypto`/`gen_random_uuid()` or `uuid-ossp`) is one of three
common patterns for distributed-friendly IDs. The other two, well-documented
in public engineering writing: auto-incrementing integers (simplest, but a
single sequence becomes a contention point and leaks row-count information),
and Twitter's Snowflake ID scheme (a published, open-sourced design:
timestamp + worker-id + sequence packed into a 64-bit sortable integer,
generated by dedicated ID-generation nodes) — built specifically because
Twitter needed IDs that sort roughly by creation time across many database
shards, which plain random UUIDs don't. Instagram's engineering blog
similarly described sharding IDs by encoding a timestamp and shard ID rather
than using either auto-increment or random UUIDs, for the same
sort-and-shard-friendliness reason.

**Why this project differs (or doesn't)**: the DB-side vs. app-side choice
is purely an environment-provisioning simplification (`decisions.md` #2 —
avoiding a `pgcrypto` extension dependency across dev/CI/prod), not a
scale-driven ID-scheme choice. Random UUIDv4 itself (as opposed to
Snowflake-style sortable IDs) is the right call here since there's exactly
one Postgres instance and no sharding — the property Snowflake IDs exist to
provide (cross-shard, roughly-time-sortable uniqueness) doesn't apply.

**Trade-offs**:
- Gives up: time-sortability (a UUIDv4 tells you nothing about insertion
  order, unlike Snowflake IDs or `ULID`s) and the slightly smaller index
  footprint of a sequential integer key.
  Gains: no coordination needed between the application and the database on
  who generates ids, and no dependency on any Postgres extension across every
  environment this runs in.
- Worth revisiting if: this ever shards across multiple database instances
  (Snowflake-style IDs solve a real problem there) or a feature needs
  "list rows in creation order by id alone" — neither applies at one
  Postgres instance with `createdAt` columns already available for
  ordering.

---

## Summary

For a single-instance, single-database, three-role portfolio project, the
simpler approach is clearly correct in every section above except one: the
lack of refresh-token reuse detection (#2) and the lack of an
access-token-revocation path (#1) are real gaps that a production system
handling actual attacker traffic would want, even if they're not worth
building preemptively here. Everything else — the JWT/opaque-refresh split,
claims-based RBAC, bcrypt, skipping `AuthenticationManager`, and app-side
UUID generation — isn't a scaled-down compromise; it's the same shape most
real systems use at this problem's actual size, with the more elaborate
alternatives (reuse-detection, relationship-based auth, Argon2, pluggable
auth providers, Snowflake IDs) solving problems (real attacker traffic,
complex permission graphs, multiple credential sources, sharded databases)
this project doesn't have yet.
