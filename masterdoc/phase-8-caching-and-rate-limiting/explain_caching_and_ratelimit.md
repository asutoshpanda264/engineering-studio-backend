# explain_caching_and_ratelimit.md — how both mechanisms actually work

## Caching — the two cached reads

```
GET /scenarios         -> ScenarioService.listPublished()   @Cacheable("scenarios-published-list")
GET /scenarios/{id}    -> ScenarioService.getPublished(id)  @Cacheable("scenarios-published", key = "#id")
```

`@EnableCaching` (`config.CacheConfig`) turns on annotation processing;
Boot's own `RedisCacheConfiguration` supplies the actual `RedisCacheManager`
(triggered by `spring.cache.type: redis` in `application.yml`), pointed at
the same Redis connection `leaderboard.LeaderboardService` already uses
(Phase 6) — no separate cache infrastructure.

`listPublished()` takes no parameters, so Spring's default
`SimpleKeyGenerator` caches it under one fixed key (`SimpleKey.EMPTY`) —
there's exactly one cached value for "the whole published list," not one
per caller. `getPublished(id)` is keyed by `#id` (SpEL referencing the
method parameter) — one cached value per scenario id.

## Eviction — one rule: anything that could change a PUBLISHED scenario's visible content evicts both caches

```java
@Caching(evict = {
    @CacheEvict(cacheNames = PUBLISHED_SCENARIO_CACHE, key = "#id"),
    @CacheEvict(cacheNames = PUBLISHED_LIST_CACHE, allEntries = true)
})
@Transactional
public ScenarioResponse update(...) { ... }   // and publish(...), archive(...) — same shape
```

`PUBLISHED_LIST_CACHE` only ever holds ONE value (the whole list), so
there's no per-id key to target — `allEntries = true` clears it entirely,
correct even though most of the 32+ other published scenarios in that
list didn't change. `delete()` deliberately has no `@CacheEvict` at all —
see decisions.md #5 for why that's not an oversight.

## Rate limiting — one Redis counter, two call sites

`common.ratelimit.RateLimiter.allow(key, limit, window)`:

```
INCR key            -- Redis returns the count AFTER incrementing
if count == 1:
    EXPIRE key window   -- only the request that STARTS a fresh window sets its length
return count <= limit
```

`common.ratelimit.RateLimitFilter` (registered in `SecurityConfig`,
`.addFilterAfter(..., JwtAuthFilter.class)`) decides the key + limit per
request:

| Request | Redis key | Limit |
|---|---|---|
| `POST /auth/login` or `/auth/register` | `ratelimit:auth-ip:<remoteAddr>` | `app.rate-limit.auth-requests-per-minute` |
| `POST /attempts/{id}/submit`, authenticated | `ratelimit:submit-user:<userId>` | `app.rate-limit.submit-requests-per-minute` |
| anything else | (not rate-limited) | — |

An unauthenticated `submit` call isn't rate-limited at all — it 401s a
few filters later regardless, so there's no expensive work to protect for
that caller (see decisions.md #6). Over the limit, the filter writes a
429 with the project's normal `ApiError` JSON shape and a `Retry-After`
header, and never calls `filterChain.doFilter(...)` — the request never
reaches Spring Security's authorization decision, let alone the
controller.

## Why the "test" Spring profile disables rate limiting (and one test class turns it back on)

`src/test/resources/application-test.yml` sets both limits to 10000/minute
— every OTHER integration test's own `registerAs()`/`submit()` helpers
call these two endpoints for real, dozens of times per test class, all
within real seconds of wall-clock time; the production default (10-20/min)
would trip on unrelated tests. `RateLimitIntegrationTest` is the one place
that overrides back down to 3/minute via `@TestPropertySource` — a
class-level property source wins over the profile YAML — specifically to
prove the 429 path actually fires. See decisions.md #10.

## Why `AbstractIntegrationTest` now clears every cache after each test

Same underlying fact Phase 6/7 already ran into for their own Redis
writes: `@Transactional`'s rollback only covers Postgres, and Redis
entries `@Cacheable` writes are real, permanent, and shared across every
test class in one JVM run. See decisions.md #11 — `AbstractIntegrationTest`
now clears every `CacheManager` cache in a base-class `@AfterEach`, so no
future test (or future `@Cacheable` addition) has to remember this on its
own.
