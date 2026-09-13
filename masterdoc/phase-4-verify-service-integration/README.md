# Phase 4 — Node Verify-Service, Real Integration

**Status:** ✅ done, verified three ways (unit fixture-parity, HTTP smoke test, full end-to-end through real Spring Boot + real Postgres + real Node).

## What shipped

`verify/` — a new service, wrapping the frontend's own simulation engine
(vendored, unmodified) behind `POST /verify`. `api`'s `AttemptService` now
calls it for real over HTTP (`HttpVerifyClient`, 10s timeout, no retry),
replacing Phase 3's `StubVerifyClient`. `VerifyRequest` now carries the
full scenario body (not just an id/version/seed triple), fetched via the
exact version an attempt was actually solved against.

Also landed during this phase: the monorepo restructure (`api/` + `verify/`
combined into one repo — see `masterdoc/decisions.md` #7) and a real bug
found and fixed by the fixture-parity test (`decisions.md` #2 — a node
shape mismatch that silently zeroed out cost calculations).

## Files in this repo

- `verify/sync-vendor.sh`, `verify/vendor/src/` — the vendored engine code
- `verify/src/graphAdapter.ts`, `verify.ts`, `server.ts`
- `verify/test/verify.fixtureParity.test.ts`
- `api/src/main/java/.../attempt/verify/HttpVerifyClient.java`,
  `VerifyRequest.java` (revised)
- `api/src/main/java/.../config/VerifyServiceProperties.java`
- `api/src/test/java/.../support/FakeVerifyClient.java`

## Docs in this folder

- `decisions.md` — 6 entries: the vendoring approach, the `fakeNode` shape
  bug (the standout finding of this phase), the full-scenario-body
  contract, real-version-checking discipline (a second encounter with the
  Phase 1 lesson, in a new ecosystem), the three-layer verification
  strategy, and retiring `StubVerifyClient` in favor of a test-only fake.
- `explain_verify.md` — the request flow across both services, why the
  graph needs two different adapted shapes, and why the vendored files
  work unmodified despite referencing a path (`@/store/workshopStore`)
  that doesn't exist in this repo.
- `industry.md` — how real-world systems solve the same problems this
  phase did (vendoring, stateless scoring services, golden/contract
  testing, test-double scoping, layered verification, monorepo vs
  polyrepo), and how this project's approach compares.

## Test status

- `verify/test/verify.fixtureParity.test.ts` — 1/1, exact numeric match
  against the real, non-vendored engine.
- `api`'s `AttemptFlowIntegrationTest` — 7/7, using `FakeVerifyClient` (no
  live `verify/` process needed for the Java suite — see
  `masterdoc/explain_testing.md`).
- Full end-to-end (real `api` + real Postgres + real `verify/`, driven via
  `curl`): register → login → start attempt on the real seeded
  `url-shortener` scenario → submit → real, non-fake verify result
  returned and persisted. Numbers matched the fixture-parity test exactly;
  `optimalComposite` independently matched `url-shortener.ts`'s own
  documented reference-solution composite.
