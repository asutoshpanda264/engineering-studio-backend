# explain_auth.md — the `auth` package

What this module does and how the pieces fit together. For *why* each choice
was made over an alternative, see `decisions.md` — this file is about *how it
actually works*.

## The two kinds of token, and why there are two

- **Access token** — a JWT (`JwtService`). Signed, self-contained, short-lived
  (15 min). Carries `sub` (userId) and a `role` claim. Every request with an
  `Authorization: Bearer <token>` header gets it checked by signature alone —
  no database lookup needed to know who's calling and what role they have.
- **Refresh token** — an opaque random string (`AuthService.generateOpaqueToken`),
  32 bytes from `SecureRandom`, base64url-encoded. NOT a JWT. Long-lived
  (30 days), but every use requires a database lookup (`RefreshTokenRepository`)
  because it has to be checked against real, revocable state (`revokedAt`).

Why not just one long-lived JWT? Because a JWT can't be revoked before it
expires — it's valid purely by its signature, and there's no database row to
delete. If a JWT-only design leaked a token, that token stays usable until it
naturally expires. Splitting into a short-lived stateless token (cheap to
verify, but a leak only matters for ≤15 minutes) plus a long-lived *revocable*
token (expensive to verify — DB hit — but can be killed instantly) gets both
properties: cheap verification most of the time, real revocation when it
matters (logout, a compromised session).

## The request lifecycle, step by step

**Registration** (`POST /auth/register`):
`RegisterRequest` (validated by Bean Validation annotations — `@Email`,
`@Size(min=8)`, etc. — before the request even reaches `AuthController`) →
`AuthService.register` checks the email isn't already taken → password is
hashed with BCrypt (`PasswordEncoder`, never stored in plaintext) → a `User`
row is saved with `role = USER` (nobody self-registers as admin/contributor —
that has to be granted separately, in a later milestone's admin endpoint).

**Login** (`POST /auth/login`):
`AuthService.login` looks the user up by email, compares the submitted
password against the stored hash via `passwordEncoder.matches(...)` (BCrypt
handles its own salt automatically — we never manage salts ourselves), and if
it matches, calls `issueTokenPair`: generates a fresh access token via
`JwtService`, generates a fresh opaque refresh token, hashes it (SHA-256, see
`decisions.md` for why not BCrypt here), and persists a `RefreshToken` row
before returning both raw tokens to the client. The raw refresh token is
returned to the caller exactly once — the database only ever stores its hash.

**Every subsequent authenticated request**:
`JwtAuthFilter` runs before Spring Security's own filters, reads the
`Authorization` header, and if there's a valid Bearer JWT, populates the
`SecurityContext` with the userId (as principal) and a `ROLE_<X>` granted
authority derived straight from the token's `role` claim. No token, or an
invalid one, and the filter just does nothing — the request proceeds as
anonymous, and whether that's allowed is entirely up to `SecurityConfig`'s
path rules or a controller method's `@PreAuthorize`.

**Refresh** (`POST /auth/refresh`):
The presented refresh token is hashed and looked up. If it's not found,
already revoked, or expired → 401. If it's valid, it's immediately marked
revoked (`revokedAt = now`) and a **brand new** access+refresh pair is issued
— this is rotation (see `decisions.md`'s note on why). The old refresh token
can never be used again after this point, even if it hadn't expired yet.

**Logout** (`POST /auth/logout`):
Just marks the presented refresh token's `revokedAt`. Idempotent — calling it
twice, or with an already-invalid token, is a silent no-op, not an error.

## RBAC enforcement — two layers, doing two different jobs

1. **`SecurityConfig`'s path rules** — coarse-grained: is *any* authenticated
   user required at all for this path, or is it public? (E.g. `GET /scenarios/**`
   is public; everything else defaults to `authenticated()`.)
2. **`@PreAuthorize("hasRole('ADMIN')")`** on individual controller methods
   (see `AdminPingController`) — fine-grained: which *specific role* can call
   this specific method. This only works because `@EnableMethodSecurity` is on
   `SecurityConfig`, and because `JwtAuthFilter` already put a `ROLE_ADMIN`-style
   granted authority into the `SecurityContext` for Spring Security's
   `hasRole(...)` expression to check against.

## What a request actually carries about "who is this"

Deliberately minimal: the JWT's principal is just the userId (a `UUID`), not
a full `User` object. Any endpoint that needs more than id+role (email,
display name, streak) does one extra database lookup by primary key
(`AuthController.me` is the example) rather than cramming more fields into
the token — a token's claims are fixed at issuance, so if they held email or
display name and the user later changed either, every token issued before
that edit would keep asserting stale data until it expired.

## Testing approach

`AuthFlowIntegrationTest` (extends `AbstractIntegrationTest`, which spins up
a real ephemeral Postgres via Testcontainers — no mocks, no H2) exercises the
whole lifecycle above end-to-end through `MockMvc`, including the two
properties worth actually proving rather than assuming: that role changes
require a fresh login to take effect (old JWTs keep their stale role claim
until they expire — proven by promoting a user mid-test and confirming their
*existing* token still gets 403), and that refresh rotation really does
invalidate the previous token (proven by using a refresh token twice and
expecting the second use to fail).
