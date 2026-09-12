# decisions.md — Phase 8: Caching + Rate Limiting

Decisions specific to `scenario`'s new caching and the new
`common.ratelimit` package. Project-wide decisions live in
`masterdoc/decisions.md`.

---

## 1. Cache scope: the two PUBLIC scenario reads only, nothing else

- **Chose:** `@Cacheable` on `ScenarioService.listPublished()` and
  `getPublished(String id)` only — `listDrafts`/`getVersion` stay
  uncached.
- **Why these two:** they're the highest-traffic, highest-payload reads
  in the app (every visitor browsing the catalogue hits them, and a
  scenario's JSON body — entities, connections, traffic pattern,
  constraints — is large) AND the cheapest to keep correct: a PUBLISHED
  scenario only changes on an explicit admin action (`update`, `publish`,
  `archive`), each of which is a natural, precise eviction point.
- **Why not `listDrafts`/`getVersion`:** drafts are edited by their
  owning contributor iteratively — caching them risks a contributor
  seeing their own stale edit reflected back, which is a worse experience
  than the redundant read it would save. Version history
  (`/scenarios/{id}/versions/{version}`) is read rarely (mostly a
  "compare what changed" debugging view, not a hot path) — caching it
  would add eviction surface for very little benefit.
- **Why not the Phase 6 leaderboards or Phase 7 daily-challenge reads
  too:** leaderboards already read from Redis directly (ZSETs) — a
  `@Cacheable` layer on top of an already-fast Redis read is redundant.
  `daily_challenges` is one row read via a get-or-create that's already
  cheap and already effectively "cached" by its own persisted-on-first-need
  design (Phase 7) — a second caching layer over it would just be
  duplicating that mechanism, not adding real value.

## 2. Redis via Spring's Cache abstraction — no new caching technology

- **Chose:** `spring-boot-starter-cache` + `spring.cache.type: redis`,
  letting Boot's own `RedisCacheConfiguration` auto-configure a
  `RedisCacheManager` over the SAME Redis connection Phase 6 already
  added — `@Cacheable`/`@CacheEvict`/`@Caching` annotations, no custom
  cache-manager bean.
- **Considered:** Caffeine (in-process, per-instance).
- **Why this instead:** this project already pays for a Redis instance
  (Phase 6's leaderboards); reusing it for scenario caching is zero new
  infrastructure and, unlike an in-process cache, stays consistent if
  this app ever runs as more than one instance. Caffeine would be
  strictly simpler for a single instance but is a second caching
  technology to reason about for no real gain at this project's scale.

## 3. TTL is a safety net, not the consistency mechanism — eviction-on-mutation is

- **Chose:** `spring.cache.redis.time-to-live: 10m`, applied uniformly,
  alongside EXPLICIT `@CacheEvict`/`@Caching` on every mutation
  (`update`, `publish`, `archive`) that could change what's cached.
- **Why both:** the explicit evictions are what make the cache correct
  moment-to-moment — a reader should never see stale content for longer
  than it takes the next mutation's eviction to run. The TTL exists
  purely as a bound on the (small, believed-eliminated) blast radius of a
  MISSED eviction — a future mutation method added without remembering to
  evict, a manual DB edit outside the app — capping "how stale can this
  ever get" at 10 minutes instead of forever, rather than being relied on
  as the primary correctness mechanism.

## 4. `update()` evicts unconditionally, even though most edits target a DRAFT (never cached)

- **Chose:** `update()` always evicts both scenario caches for the edited
  id, regardless of the scenario's status before the edit.
- **Why:** an ADMIN can edit an already-PUBLISHED scenario too (see
  `assertCanEdit` — only a non-admin is restricted to DRAFT-only edits),
  and there's no cheap way to know which case this is before the write
  happens without an extra read. Evicting unconditionally costs a no-op
  cache miss on the (more common) draft-edit path and buys correctness on
  the less common published-edit path — a clearly worthwhile trade.

## 5. `delete()` deliberately evicts nothing

- **Chose:** no `@CacheEvict` on `delete()`.
- **Why:** `delete()`'s own check (`Only a draft scenario can be
  deleted — archive a published one instead`) means it can only ever
  succeed on a DRAFT scenario — and a DRAFT was never present in either
  `PUBLISHED_SCENARIO_CACHE` or `PUBLISHED_LIST_CACHE` in the first place
  (both only ever cache PUBLISHED content). Adding an evict here would be
  dead code doing nothing, not a safety margin.

## 6. Rate limiting: two specific endpoints, not a blanket per-request limit

- **Chose:** `POST /auth/login`/`POST /auth/register` (per client IP) and
  `POST /attempts/{id}/submit` (per authenticated user) only.
- **Why these two, specifically:** they're the two places a single
  request either (a) tests a guessed credential against the system
  (brute-force/credential-stuffing risk) or (b) triggers real downstream
  work worth protecting — `submit` calls the verify-service over real
  HTTP and does real computation. Every other endpoint in this app is
  either a cheap read (now additionally cache-backed for the hottest
  ones) or a low-frequency admin/contributor action naturally
  self-limited by who can even call it (`@PreAuthorize`).
- **Considered:** a blanket per-IP/per-user limit across every endpoint,
  via a library (Bucket4j).
- **Why not (for this milestone):** broader coverage for genuinely low
  marginal protection here — this app's read endpoints aren't
  individually expensive, and a general limiter is real added scope
  (picking per-endpoint limits for a dozen+ routes, verifying a new
  dependency) for a threat model this project's actual read traffic
  doesn't present. Two precisely-targeted limits, understood completely,
  beat a general mechanism applied without a specific reason at each site.

## 7. Hand-rolled Redis `INCR`+`EXPIRE` fixed-window counter, not a rate-limiting library

- **Chose:** `RateLimiter.allow(key, limit, window)` — one `INCR`, an
  `EXPIRE` set only on the first hit in a fresh window.
- **Considered:** Bucket4j (token-bucket, Redis-backed) or a
  sliding-window-log implementation.
- **Why this instead:** the exact same reasoning Phase 6 already used for
  hand-rolling the leaderboard ZSETs instead of reaching for a library —
  the whole mechanism here is two well-understood Redis commands, and
  writing it directly means there's nothing to look up when explaining
  how it works. **Accepted trade-off:** a fixed window allows up to
  `2 × limit` requests across a window BOUNDARY (a burst just before a
  window ends, followed immediately by a fresh burst once it rolls over)
  — a real, known limitation of this exact scheme, unlike a sliding-window
  or token-bucket algorithm. Accepted here because the actual goal
  (blunt brute-force / spam, not enforce an exact hard ceiling) tolerates
  that slack completely — a determined attacker getting `2×` the budget
  for one boundary moment is not a meaningfully different outcome from
  the stated goal.

## 8. `RateLimitFilter` runs AFTER `JwtAuthFilter`, BEFORE Spring Security's authorization decision

- **Chose:** `.addFilterAfter(new RateLimitFilter(...), JwtAuthFilter.class)`.
- **Why after `JwtAuthFilter`:** the per-user `/attempts/*/submit` limit
  needs `SecurityContextHolder`'s `Authentication` already populated (set
  by `JwtAuthFilter`) to know WHO to key the counter by.
- **Why before Spring Security's own authorization filter (implicitly,
  by being earlier in the chain):** an over-limit caller gets a 429
  before Spring Security even decides whether the request would have been
  allowed through, and — for `submit` specifically — well before
  `AttemptService.submit`'s real verify-service HTTP call would ever run.
  Blocking as early as possible is the whole point of a request budget
  meant to protect real downstream work.

## 9. Login and register share ONE per-IP counter, not two separate ones

- **Chose:** `RateLimitFilter` uses the same Redis key
  (`ratelimit:auth-ip:<ip>`) for both `POST /auth/login` and
  `POST /auth/register` from a given IP.
- **Why:** both are credential-adjacent flows reachable with no token at
  all — splitting them into two independent budgets would let an attacker
  double their effective throughput by alternating between the two
  endpoints. One shared budget per IP closes that gap without adding a
  second counter to reason about.

## 10. Test-profile rate limits raised to effectively "off" — a real correctness need, caught before it broke anything

- **What was checked before writing a single rate-limit test:** every
  existing integration test class's `registerAs()`-style helper calls
  `POST /auth/login` for real, via MockMvc, from the same fixed
  `127.0.0.1` remote address `MockHttpServletRequest` uses by default. A
  test class with several `@Test` methods (`LeaderboardIntegrationTest`,
  `DailyChallengeIntegrationTest`, ...) legitimately calls it well past
  any reasonable PRODUCTION rate limit (10/minute), all within one real
  minute of fast, in-process test execution — meaning shipping the
  production default unchanged into the shared "test" Spring profile
  would have started failing unrelated, already-passing tests with 429s,
  the moment rate limiting went live.
- **Chose:** `src/test/resources/application-test.yml` (a new file — none
  existed before) sets `app.rate-limit.*` to 10000/minute, active for
  every test class via the existing `@ActiveProfiles("test")` on
  `AbstractIntegrationTest`. `RateLimitIntegrationTest` is the one place
  that deliberately overrides back down to 3/minute via
  `@TestPropertySource`, specifically to exercise the 429 path — a
  test-class-level property source takes precedence over the
  profile-level YAML, so only that one class actually sees a tight limit.
- **Scenario it covers:** every pre-existing test class kept passing
  unmodified once rate limiting shipped — verified by re-running the full
  regression sweep, not assumed.

## 11. A real bug, caught by the first actual cache test run: `RedisCacheManager`'s default value serializer needs `Serializable`, and this project's DTOs are records

- **What happened:** `ScenarioCacheIntegrationTest`'s first real run
  failed every test with a 500, not the expected 200 — the cache layer
  itself was throwing before a response was ever produced.
- **Why:** `RedisCacheManager`'s own default value serializer is
  `JdkSerializationRedisSerializer` — plain Java serialization, which
  requires every cached type to implement `java.io.Serializable`.
  `ScenarioResponse` (and every other DTO in this app) is a `record` that
  doesn't, deliberately — nothing about this project's design should be
  shaped around `java.io.Serializable`, a mechanism this codebase has
  never otherwise used.
- **The fix:** a `RedisCacheManagerBuilderCustomizer` bean
  (`config.CacheConfig`) swaps the value serializer to
  `GenericJacksonJsonRedisSerializer` — verified (via `javap` against the
  actual `spring-data-redis-4.1.1.jar`, not guessed) to be the Jackson-3.x
  (`tools.jackson`) variant, distinct from the "2"-suffixed
  `GenericJackson2JsonRedisSerializer` that pulls in classic Jackson 2.x —
  the same real-vs-transitive-dependency distinction
  `common.json.JsonUtil`'s own Javadoc already documents from Phase 2.
  Constructed with the SAME `ObjectMapper` bean Boot's own HTTP layer
  uses, so a cache hit's JSON is byte-for-byte identical to a live
  response's.
- **A second thing verified, not assumed, while fixing this:** the
  customizer reads `builder.cacheDefaults()` (the config Boot's own
  auto-configuration already populated, including
  `spring.cache.redis.time-to-live` from application.yml) and layers the
  new serializer onto THAT, rather than starting from a fresh
  `RedisCacheConfiguration.defaultCacheConfig()` — which would have
  silently dropped the TTL. `RedisCacheManagerBuilderCustomizer` beans run
  after Boot's own property-driven setup specifically so this ordering is
  safe.
- **Scenario it covers:** the general lesson worth remembering here — any
  future `@Cacheable` addition over a non-`Serializable` type (which, in
  this codebase, is every DTO) is already covered by this one fix; no
  future phase needs to rediscover it.

## 12. `AbstractIntegrationTest` now clears every Spring Cache after each test — caching is a NEW implicit source of the same cross-test Redis leakage Phase 6/7 already knew about

- **What was noticed before it caused a failure:** `ScenarioService`'s
  new `@Cacheable` reads write real entries into the SAME shared Redis
  container every test class already uses — and unlike a Postgres write,
  those entries are NOT covered by `AbstractIntegrationTest`'s
  per-test-method transaction rollback. A scenario published (and then
  GET-cached) inside one test method, whose surrounding transaction then
  rolls back, would leave a Redis-cached response describing data that no
  longer exists in Postgres — visible to every later test in the same
  JVM run, exactly the class of bug Phase 6's `LeaderboardIntegrationTest`
  and Phase 7's `ProblemProgressConcurrencyTest` fix each dealt with for
  their own EXPLICIT Redis writes, just showing up here as an IMPLICIT
  side effect of an ordinary cached read instead.
- **Chose:** added an `@AfterEach` to `AbstractIntegrationTest` itself
  (not per-test-class) that clears every registered `CacheManager` cache
  after each test method — general and forward-compatible, so no future
  `@Cacheable` addition needs its own test class to remember this.
- **Why the shared base class, not per-test-class cleanup (the Phase 6/7
  pattern):** those phases' Redis writes were narrow and deliberate (one
  service publishing specific events), naturally scoped to the few test
  classes that actually exercised them. Scenario-catalog reads are
  exercised by nearly every integration test in the suite (any test that
  registers a user, publishes a scenario, or lists the catalog) — fixing
  this once, centrally, is both less repetitive and less likely to be
  forgotten than expecting every future test class to remember it.
