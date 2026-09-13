# industry.md — Phase 8: Caching + Rate Limiting

How real-world systems solve the same problems this phase solved, and how
this project's approach compares. See `decisions.md` for why each choice was
made and `explain_caching_and_ratelimit.md` for how the mechanisms actually
work — this file adds the external comparison only.

---

### 1. Cache invalidation: eviction-on-write as the correctness mechanism, TTL as a safety net

**The problem**: a cache that never invalidates serves stale data forever;
a cache that relies purely on time-based expiry serves stale data for up to
the whole TTL window after every write. A system needs to decide which of
these is the *real* correctness guarantee and which is a backstop.

**How this project does it**: `GET /scenarios` and `GET /scenarios/{id}`
are cached with explicit `@CacheEvict`/`@Caching` on every mutation that
could change what they'd return (`update`, `publish`, `archive`), so a
reader is never stale for longer than it takes the next mutation's eviction
to run. A uniform 10-minute TTL sits underneath, explicitly documented as a
bound on the blast radius of a *missed* eviction, not the primary
mechanism. `update()` evicts unconditionally even on the more common
draft-edit path (which never touches a cached entry) because there's no
cheap way to know in advance which case applies; `delete()` deliberately
evicts nothing because it can only ever succeed on a DRAFT, which was never
cached. See `decisions.md` #1, #3, #4, #5.

**Industry approaches**: "invalidate on write, TTL as a backstop" is the
standard shape of the cache-aside pattern used throughout web backends —
AWS's own caching documentation (for ElastiCache) describes this exact
combination: explicit invalidation for correctness, a TTL as insurance
against a missed invalidation path. CDNs solve the same problem at a
different layer with an explicit **purge/invalidate API** — Cloudflare and
Fastly both let an origin explicitly invalidate a cached URL immediately
after a content change, rather than waiting out a `Cache-Control` max-age,
for the same reason this project evicts on `update`/`publish`/`archive`
instead of just trusting the TTL. Facebook's publicly-described **TAO**
graph-cache system takes eviction correctness even further, propagating
explicit invalidations from the write path across cache tiers, precisely
because relying on TTL alone at that scale would mean an unacceptable
window of visible staleness after any write.

**Why this project differs (or doesn't)**: it doesn't differ — this is the
same pattern used at every scale that cares about correctness rather than
"probably fine," applied here to two reads specifically chosen because
their invalidation triggers are precise and few (`decisions.md` #1 notes
this directly: a published scenario only changes on an explicit admin
action, which makes eviction-on-mutation cheap and complete rather than
merely aspirational).

**Trade-offs**:
- Gives up: nothing versus the industry pattern at this scale — there's no
  cache-invalidation-propagation problem here (one app instance, one Redis)
  the way there is for a CDN or a multi-tier cache like TAO.
- Gains: correctness that doesn't depend on trusting a TTL window, for the
  cost of a few explicit `@CacheEvict` annotations at known mutation points.
- Worth revisiting if: caching ever extends to a read whose invalidation
  triggers *aren't* few and precise (e.g. a computed view depending on many
  unrelated tables) — that's the point a TTL-heavier, eviction-lighter
  approach (or event-driven invalidation across services) starts making
  more sense than enumerating every mutation site.

### 2. Fixed-window counter vs. sliding-window/token-bucket rate limiting

**The problem**: limiting how often a client can hit an endpoint requires
tracking request counts against a time window, and the exact algorithm
chosen trades off implementation simplicity against precision at window
boundaries.

**How this project does it**: `RateLimiter.allow(key, limit, window)` is a
hand-rolled fixed-window counter — one Redis `INCR`, with `EXPIRE` set only
on the request that starts a fresh window. `decisions.md` #7 names the
accepted trade-off explicitly: a fixed window allows up to `2×` the limit
across a window boundary (a burst just before expiry, immediately followed
by a fresh burst once the window rolls over) — a real, known limitation of
this exact scheme.

**Industry approaches**: fixed-window counters are one of several
well-documented rate-limiting algorithms, and the boundary-burst problem
this project accepts is exactly the reason two alternatives exist and are
widely used in production: **token bucket** (Stripe's and Amazon API
Gateway's publicly documented rate-limiting model — a bucket refills
continuously at a fixed rate and requests consume tokens, with no hard
window edges to burst across) and **sliding-window log/counter** (weights
the current and previous window by elapsed time, smoothing the exact
boundary case fixed-window has). Cloudflare's public rate-limiting
documentation describes offering a sliding-window approximation for
exactly this reason. Bucket4j (this project's own `decisions.md` #7 names
it as the considered alternative) is a widely-used Java library
implementing token bucket over Redis for exactly this use case.

**Why this project differs (or doesn't)**: a deliberate, explicitly-argued
trade-off, not an oversight — `decisions.md` #7 states plainly that the
actual goal is blunting brute-force/spam, not enforcing an exact ceiling,
and a `2×` burst at one boundary moment doesn't materially change that
outcome. This mirrors the same hand-rolled-over-library reasoning Phase 6
used for leaderboard ZSETs: two well-understood Redis commands, fully
explainable, versus a library whose internals would need to be trusted
rather than understood.

**Trade-offs**:
- Gives up: precise ceiling enforcement — a determined attacker can extract
  roughly double the configured budget by timing requests around a window
  boundary, which a token-bucket or sliding-window scheme would prevent.
- Gains: the entire mechanism is two Redis commands with no library to
  learn, audit, or trust — trivially explainable and auditable end to end.
- Worth revisiting if: this ever needs to enforce a hard contractual limit
  (a paid API tier with a strict quota, not just abuse-blunting) — that's
  the point boundary precision stops being acceptable slack and a
  token-bucket implementation (Bucket4j or hand-rolled) becomes worth the
  added complexity.

### 3. Targeted rate limiting on specific expensive/sensitive endpoints, not a blanket limit

**The problem**: a system with many endpoints of wildly different cost and
risk (a cheap public read vs. an unauthenticated login attempt vs. an
expensive downstream call) has to decide whether to protect everything
uniformly or spend limiting effort where it actually matters.

**How this project does it**: only two call sites are rate-limited —
`POST /auth/login`/`/auth/register` (per client IP, brute-force/
credential-stuffing risk) and `POST /attempts/{id}/submit` (per
authenticated user, the one endpoint triggering a real downstream
verify-service HTTP call). Login and register additionally share one
counter, not two, specifically because splitting them would let an
attacker double effective throughput by alternating endpoints. See
`decisions.md` #6 and #9.

**Industry approaches**: differentiated, endpoint-specific rate limiting
(rather than one blanket number) is the standard approach documented by
every major public API — GitHub's REST API documents separate rate-limit
categories for search vs. general endpoints specifically because search is
more expensive per call; OWASP's own API security guidance calls out
authentication endpoints (login, password reset, registration) as
requiring dedicated brute-force-focused limits distinct from general API
throttling, precisely because they're credential-testing surfaces reachable
without a token. Sharing one budget across adjacent credential-adjacent
endpoints (this project's login+register coupling) mirrors the same logic
security guidance gives for treating login and password-reset flows as one
combined abuse surface rather than independently-budgeted endpoints.

**Why this project differs (or doesn't)**: it doesn't differ — this is
exactly the industry-recommended approach (protect what's actually
risky/expensive, not everything uniformly), and `decisions.md` #6
explicitly rejected a Bucket4j-backed blanket limit across a dozen-plus
routes as scope disproportionate to a threat model this project's actual
read traffic doesn't present.

**Trade-offs**:
- Gives up: no protection at all on any endpoint outside these two — a
  future expensive or abusable endpoint added later needs someone to
  remember to add a limit for it explicitly; there's no default floor.
- Gains: two limits, fully understood and reasoned about, instead of a
  general mechanism with per-route configuration for routes that don't
  need it.
- Worth revisiting if: a future endpoint becomes genuinely expensive or
  abusable (a new endpoint calling an external paid API, say) — that's a
  new named case for the same targeted approach, not a reason to switch to
  a blanket mechanism.

### 4. Reusing existing shared infrastructure (Redis) for a second concern instead of adding a new caching technology

**The problem**: adding a new capability (caching) to a system that already
runs infrastructure (Redis, provisioned for leaderboards in Phase 6) raises
the question of whether to reuse what's already there or introduce a
purpose-built alternative.

**How this project does it**: Redis-backed caching via Spring's Cache
abstraction (`spring.cache.type: redis`), pointed at the exact same Redis
connection Phase 6's leaderboards already use — no second cache
infrastructure. Caffeine (in-process, per-instance) was considered and
rejected specifically because this project already pays for Redis, and an
in-process cache would also stop being consistent the moment this app runs
as more than one instance. See `decisions.md` #2.

**Industry approaches**: using one general-purpose data store for multiple
concerns (caching, rate-limit counters, session state, pub/sub, queues) is
a well-known Redis usage pattern precisely because Redis is commonly
described as a "Swiss-army" infrastructure piece for exactly this reason —
its own documentation and ecosystem materials market it across all of these
use cases. The alternative — a dedicated tool per concern (Memcached purely
for caching, a separate rate-limiting service or API-gateway-level limiter
like Envoy's or Kong's built-in rate limiting) — is common at larger
organizations specifically because isolating each concern's load lets them
scale and fail independently; a shared Redis instance means a rate-limiter
hot spot and a cache traffic spike compete for the same resource.

**Why this project differs (or doesn't)**: it doesn't differ from the
"reuse what you have" instinct that's completely standard at small scale —
the reasoning `decisions.md` #2 gives (zero new infrastructure, and
correctness across horizontal scaling that an in-process cache couldn't
give) is the same reasoning that justifies consolidating onto one Redis
instance generally, before load ever justifies splitting concerns apart.

**Trade-offs**:
- Gives up: fault and load isolation — a Redis outage or resource
  exhaustion now takes down caching, rate limiting, *and* leaderboards
  simultaneously, where dedicated infrastructure per concern would degrade
  independently.
- Gains: zero additional infrastructure to provision, monitor, or pay for,
  and one shared connection pool/config to reason about.
- Worth revisiting if: any one of these three concerns (caching, rate
  limiting, leaderboards) grows enough load or reliability requirements
  that it needs to fail independently of the others — that's the point
  splitting onto dedicated infrastructure (a separate Redis instance, or a
  purpose-built tool per concern) becomes worth the added operational
  surface.

### 5. Cache value serialization format

**The problem**: caching an object in an external store (rather than
in-process memory) requires serializing it to bytes and back — the format
chosen affects compatibility with the language's own type system, cross-
version safety, and interoperability with anything else reading the cache.

**How this project does it**: `RedisCacheManager`'s default value
serializer (`JdkSerializationRedisSerializer`, plain Java serialization)
failed outright on this project's DTOs, which are `record`s that
deliberately don't implement `Serializable`. The fix — a
`RedisCacheManagerBuilderCustomizer` swapping in
`GenericJacksonJsonRedisSerializer` (verified via `javap` against the real
jar to be the Jackson 3.x variant, not the classic-Jackson-pulling
"2"-suffixed one) — constructed with the *same* `ObjectMapper` bean the
app's HTTP layer already uses, so a cache hit's JSON is byte-for-byte
identical to a live response. See `decisions.md` #11.

**Industry approaches**: JSON as the cache serialization format (rather
than a JVM-specific binary format like Java serialization) is a common
choice specifically because it decouples the cached value from any one
language's type system — the same reason most polyglot or
service-boundary-spanning caches (a cache a non-JVM process might also
read, or one that needs to survive a class's field changes across
deploys) favor JSON, Protobuf, or MessagePack over Java's native
serialization. Java serialization specifically is widely documented (and
was the subject of well-known CVEs) as a poor default for anything beyond
same-process, same-classloader use — a large part of why frameworks and
libraries have moved away from defaulting to it, and exactly the trap this
project's `RedisCacheManager` default fell into.

**Why this project differs (or doesn't)**: it doesn't differ from best
practice — the fix moved *toward* the industry-preferred approach (JSON,
via the same Jackson stack already used for real HTTP responses) away from
a legacy default (`JdkSerializationRedisSerializer`) that Spring Data Redis
ships mainly for backward compatibility, not because it's recommended.
`decisions.md` #11 frames this explicitly as an unwanted default that
conflicted with a deliberate, pre-existing project choice (DTOs as records,
never designed around `Serializable`) rather than a genuine trade-off
between two reasonable options.

**Trade-offs**:
- Gives up: nothing meaningful — JSON serialization has marginally larger
  payloads and slightly more CPU cost than a compact binary format
  (Protobuf/MessagePack), but neither was ever a design goal here.
- Gains: cached values are human-readable in Redis (useful for debugging),
  compatible with the project's actual DTO shapes (records) with no
  `Serializable` retrofit, and identical byte-for-byte to what a live HTTP
  response would have serialized to.
- Worth revisiting if: cache payload size or serialization CPU cost ever
  becomes a measured bottleneck — at real high-throughput scale, a binary
  format (Protobuf, MessagePack) trims both at the cost of losing JSON's
  human-readability for debugging, not a concern this project's actual
  traffic presents.

---

## Summary

For a single-instance app with one shared Redis, every choice in this phase
is either the direct industry-standard pattern (eviction-on-write with a
TTL safety net, endpoint-targeted rate limiting, JSON-based cache
serialization) or a deliberately simpler variant of one, explicitly argued
rather than assumed (a fixed-window counter instead of token bucket,
accepting a bounded and stated `2×` boundary-burst risk; reusing one Redis
instance for caching, rate limiting, and leaderboards instead of isolating
each behind dedicated infrastructure). The one real trade-off worth
flagging plainly is infrastructure consolidation (#4): sharing one Redis
instance across three concerns means a problem in any one of them can
degrade all three together, which a system at real production scale with
independent reliability requirements per concern would not accept — but at
this project's actual load, provisioning three separate pieces of
infrastructure to protect against a failure mode that has never occurred
would be solving a problem this project doesn't have yet.
