# Phase 8 — Caching + Rate Limiting

**Status:** ✅ done, verified against a real Postgres + Redis via Testcontainers.

## What shipped

Redis-backed caching (via Spring's `@Cacheable`/`@CacheEvict`, reusing
the Phase 6 Redis instance) on the two hottest, highest-payload public
reads — `GET /scenarios` and `GET /scenarios/{id}` — with precise
eviction on every mutation that could change what they'd return
(`update`, `publish`, `archive`). A 10-minute TTL backs it up as a safety
net, not the primary correctness mechanism.

A hand-rolled Redis fixed-window rate limiter (`INCR`+`EXPIRE`, no new
library) protecting `POST /auth/login`/`/auth/register` (per client IP)
and `POST /attempts/{id}/submit` (per authenticated user) — the two
endpoints reachable without a valid token, or expensive enough (a real
verify-service call) to be worth a budget.

No new database migration — everything here lives in Redis or as plain
Java config.

## Files in this repo

- `api/src/main/java/.../config/CacheConfig.java`,
  `RateLimitProperties.java` (new)
- `api/src/main/java/.../common/ratelimit/` — `RateLimiter`,
  `RateLimitFilter` (new package)
- `api/src/main/java/.../scenario/ScenarioService.java` (caching
  annotations) (edited)
- `api/src/main/java/.../config/SecurityConfig.java` (registers
  `RateLimitFilter`) (edited)
- `api/src/main/resources/application.yml` (`spring.cache.*`,
  `app.rate-limit.*`) (edited)
- `api/pom.xml` (`spring-boot-starter-cache`) (edited)
- `api/src/test/resources/application-test.yml` (new — raises the test
  profile's rate limits)
- `api/src/test/java/.../support/AbstractIntegrationTest.java` (clears
  every cache after each test) (edited)
- `api/src/test/java/.../scenario/ScenarioCacheIntegrationTest.java`,
  `.../common/ratelimit/RateLimitIntegrationTest.java` (new)

## Docs in this folder

- `decisions.md` — 12 entries: cache scope (scenario catalog reads only,
  and why not more), Redis-via-Spring-Cache over a second caching
  technology, TTL-as-safety-net vs. eviction-as-the-real-mechanism, two
  scenario-mutation eviction-shape decisions (`update` evicts
  unconditionally, `delete` deliberately evicts nothing), which two
  endpoints get rate-limited and why not a blanket limit, the hand-rolled
  fixed-window counter (and its accepted boundary-burst trade-off), the
  filter's position in the chain, sharing one budget between login and
  register, a real test-infrastructure correctness need caught before it
  broke anything (test-profile rate limits), a real
  `NotSerializableException` bug caught by the first actual cache test
  run (records vs. `JdkSerializationRedisSerializer`, fixed with the
  Jackson-3.x `GenericJacksonJsonRedisSerializer`), and why
  `AbstractIntegrationTest` now clears every cache after each test.
- `explain_caching_and_ratelimit.md` — the two cached reads and their
  exact eviction rule, the rate limiter's Redis mechanics table (which
  request maps to which key/limit), and why the "test" Spring profile
  runs with rate limiting effectively off (with one deliberate exception).
- `industry.md` — how real-world systems solve the same problems (cache
  invalidation, rate-limiting algorithms, endpoint-targeted limits,
  shared infrastructure reuse, cache serialization), and how this
  project's approach compares

## Test status

- `ScenarioCacheIntegrationTest` — 4/4, real Postgres + Redis via
  Testcontainers. A real bug on the first run, not assumed away:
  `RedisCacheManager`'s default value serializer needs `Serializable`;
  every test failed with a 500 until `CacheConfig` switched it to
  `GenericJacksonJsonRedisSerializer` (Jackson 3.x) — see decisions.md #11.
- `RateLimitIntegrationTest` — 4/4, `@TestPropertySource`-overridden down
  to 3/minute to actually exercise the 429 path.
- A real test-infrastructure correctness need caught BEFORE it broke
  anything, not after: every existing test class's `registerAs()` helper
  calls `POST /auth/login` for real, dozens of times per class, well past
  the production rate limit within real seconds of test time — a new
  `src/test/resources/application-test.yml` raises the "test" profile's
  limits to effectively off before this was ever a problem — see
  decisions.md #10.
- Re-verified unaffected, each individually per
  `masterdoc/explain_testing.md`: `ScenarioCrudIntegrationTest` (6/6),
  `ScenarioSeedMigrationTest` (3/3 — failed once with the documented
  resource-pressure pattern after several consecutive Testcontainers JVM
  launches in one session, passed cleanly re-run alone once memory
  recovered, not a code regression), `AuthFlowIntegrationTest` (5/5),
  `AttemptFlowIntegrationTest` (7/7), `ProblemProgressIntegrationTest`
  (5/5), `ProblemProgressConcurrencyTest` (2/2), `LeaderboardIntegrationTest`
  (6/6), `DailyChallengeIntegrationTest` (10/10),
  `DailyChallengeConcurrencyTest` (1/1), `PointsCalculatorTest` (8/8),
  `LeaderboardTypeTest` (3/3).
