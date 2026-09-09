# decisions.md — Phase 1: Auth & RBAC

Decisions specific to building the `auth` package. Project-wide decisions
(stack choice, Maven, Spring Boot version, dependency selection, package
layout) live in `masterdoc/decisions.md` instead.

---

## 1. `jjwt` library for JWT issuance/validation, not Spring Authorization Server

- **Chose:** `io.jsonwebtoken:jjwt-api`/`jjwt-impl`/`jjwt-jackson` (0.12.6,
  current latest) — a lightweight library that just builds/parses/verifies
  JWTs. `JwtService` and `JwtAuthFilter` are hand-written around it.
- **Considered:** `spring-boot-starter-oauth2-resource-server` (Spring's own
  OAuth2/JWT resource-server support) and Spring Authorization Server (a
  full OAuth2/OIDC identity provider).
- **Why this instead:** Spring's OAuth2 resource-server starter is built to
  *validate* tokens issued by an external identity provider (Auth0, Okta,
  Google, a separate auth server) — it's not designed for a service that
  both issues and validates its own tokens with a username/password login
  flow, which is exactly what's needed here. Spring Authorization Server
  would solve that, but it's a full OIDC provider — a large, heavyweight
  tool for a single-service app with three roles and no third-party clients
  needing to obtain tokens. `jjwt` plus a ~100-line `JwtService` is the
  right amount of machinery for "this one Spring Boot app issues its own
  access+refresh tokens and checks them on incoming requests." Writing the
  filter by hand (rather than a black-box starter) is also more useful
  right now specifically — it's the part of Spring Security most worth
  being able to explain end-to-end in an interview.
- **Scenario it covers:** Stateless auth across requests without
  server-side session storage — the access token itself carries the user's
  id/role, verified by signature on every request, so any instance of this
  API (if ever scaled horizontally) can validate a request without a shared
  session store. (Redis comes in later, but only for *revocation* — "is
  this refresh token currently blacklisted" — not for holding session
  state itself.)

## 2. UUID generation: Hibernate-assigned (`GenerationType.UUID`), not a Postgres-side default

- **Chose:** `@GeneratedValue(strategy = GenerationType.UUID)` on every
  entity's `id` — Hibernate generates the UUID in application code before
  the INSERT, and the Flyway migration declares `id UUID PRIMARY KEY` with
  no `DEFAULT`.
- **Considered:** `DEFAULT gen_random_uuid()` at the database level (what
  the original plan doc sketched, flagged there as an open item).
- **Why this instead:** DB-side `gen_random_uuid()` needs the `pgcrypto`
  extension enabled — one more thing to provision on every environment
  (Neon, CI's Testcontainers instance, local dev). Hibernate's own UUID
  generator needs nothing extra and produces the same result (a random
  UUIDv4). The plan's open item defaulted to the DB-side version "unless
  told otherwise" — this supersedes that with the simpler option, logged
  here since it's a real deviation from what was written down.
- **Scenario it covers:** One less environment-specific setup step (a
  Postgres extension) that would otherwise need to exist identically across
  dev, CI, and every deploy target.

## 3. Refresh tokens are opaque random strings, not JWTs

- **Chose:** 32 bytes of `SecureRandom`, base64url-encoded, hashed
  (SHA-256) before storage — not a second JWT.
- **Considered:** Issuing the refresh token as its own (longer-lived)
  signed JWT, carrying a `jti` claim for revocation tracking.
- **Why this instead:** A refresh token is *always* checked against the
  database on use (to see if it's been revoked) — there's no scenario
  where it's validated by signature alone the way an access token is.
  Since a DB round-trip is unavoidable either way, a JWT's
  self-contained-ness buys nothing here, while a plain random string
  avoids an entire category of bugs (clock-skew on JWT `exp` claims,
  key-rotation affecting old refresh tokens, parsing failures) for zero
  cost.
- **Scenario it covers:** Keeps "the only place a JWT is minted/verified is
  `JwtService`, for access tokens" true as a simplifying invariant — one
  token format to reason about, not two.

## 4. Refresh-token rotation on every use

- **Chose:** Every successful `/auth/refresh` call revokes the presented
  token and issues a brand-new refresh token alongside the new access
  token.
- **Considered:** Letting a refresh token be reused freely until it
  naturally expires (30 days).
- **Why this instead:** Without rotation, a stolen refresh token is fully
  valid for up to 30 days with no way to detect the theft. With rotation,
  if an attacker ever uses a stolen refresh token, the *legitimate* user's
  next real refresh attempt fails (their copy was already invalidated by
  the attacker's use) — which is a visible, detectable signal, not silent
  indefinite compromise.
- **Scenario it covers:** A leaked/stolen refresh token (logged device,
  intercepted request, etc.) — rotation turns "permanently compromised
  until expiry" into "detectable on next legitimate use."

## 5. No `AuthenticationManager`/`UserDetailsService` — login checks the password directly in `AuthService`

- **Chose:** `AuthService.login` calls `passwordEncoder.matches(...)`
  itself against the looked-up `User` row.
- **Considered:** The textbook Spring Security pattern — implement
  `UserDetailsService`, wrap `User` in a `UserDetails` adapter, wire a
  `DaoAuthenticationProvider` into an `AuthenticationManager` bean, and
  authenticate through that.
- **Why this instead:** That machinery exists to make Spring Security
  itself responsible for deciding "is this request authenticated" on every
  request — the right tool for session/form-login flows. This API never
  does that; authentication only happens at two explicit points already
  fully controlled (`/auth/login`, `/auth/refresh`), and the *result* is a
  token handed back to the client, not a `SecurityContext` Spring populates
  itself. Adding `UserDetailsService` here would be machinery with nothing
  plugged into it — `JwtAuthFilter` (not `AuthenticationManager`) is what
  actually authenticates every *subsequent* request, by reading the token.
- **Scenario it covers:** Avoids a common source of confusion when
  relearning Spring Security — a `UserDetailsService` bean sitting unused
  alongside a hand-rolled JWT filter, in code that never actually calls it,
  is worse than not having it at all.

## 6. Hibernate DDL: `ddl-auto: validate`, and `open-in-view: false`

- **Chose:** `spring.jpa.hibernate.ddl-auto=validate` (Hibernate checks the
  entity mappings against the real schema at startup and fails fast on
  mismatch — it never creates or alters tables itself) and
  `spring.jpa.open-in-view=false`.
- **Considered:** `ddl-auto=update` (Hibernate auto-migrates the schema to
  match entities) and leaving Open Session In View on (Spring Boot's
  default).
- **Why this instead:** `update` is exactly the schema drift Flyway
  (`masterdoc/decisions.md` #4) was chosen to prevent — letting Hibernate
  quietly alter tables would make Flyway's migration history a lie about
  what the real schema is. `open-in-view=false` means a lazy-loaded
  association accessed outside a `@Transactional` service method throws
  immediately in dev, instead of "working" by accident because the session
  happened to stay open through view rendering — surfacing a real
  N+1/lazy-loading bug at dev time, not silently in production under load.
- **Scenario it covers:** Both are about catching a class of bug (schema
  drift; lazy-loading-outside-transaction) at the earliest possible point
  (startup / first request in dev) instead of in production.
