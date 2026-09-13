# Phase 1 — Auth & RBAC

**Status:** ✅ done, verified against a real Postgres via Testcontainers.

## What shipped

Full register/login/refresh/logout/me flow. JWT access tokens (15 min) +
rotating opaque refresh tokens (30 days). Role-based access control
(`ADMIN`/`CONTRIBUTOR`/`USER`) enforced via `@PreAuthorize`, verified end to
end by an RBAC smoke-test endpoint (`GET /admin/ping`).

## Files in this repo

- `api/src/main/java/.../auth/` — `User`, `Role`, `RefreshToken`, `JwtService`,
  `JwtAuthFilter`, `AuthService`, `AuthController`, repositories, DTOs
- `api/src/main/java/.../config/` — `SecurityConfig`, `JwtProperties`, `AppConfig`
- `api/src/main/java/.../admin/AdminPingController.java`
- `api/src/main/resources/db/migration/V1__auth.sql`
- `api/src/test/java/.../auth/AuthFlowIntegrationTest.java` — 5 tests

## Docs in this folder

- `decisions.md` — why each auth-specific choice was made (jjwt vs. Spring
  Authorization Server, opaque vs. JWT refresh tokens, rotation, skipping
  `AuthenticationManager`, Hibernate DDL settings)
- `explain_auth.md` — how the whole login/token/RBAC flow actually works
- `explain_boot4-migration.md` — three Spring Boot 4 package-relocation
  gotchas hit while building this, and the technique for finding any more
- `industry.md` — how real-world systems solve the same problems (token
  strategy, RBAC, password storage, etc.), and how this project's approach
  compares

## Test status

`api/mvnw test -Dtest=AuthFlowIntegrationTest` — 5/5 passing:
register→login→/me, duplicate-email conflict, 403-as-USER/200-as-ADMIN
after promotion, refresh rotation (old token rejected after use), logout
revocation.
