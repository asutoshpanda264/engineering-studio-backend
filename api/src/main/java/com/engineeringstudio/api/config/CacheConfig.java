package com.engineeringstudio.api.config;

import org.springframework.boot.cache.autoconfigure.RedisCacheManagerBuilderCustomizer;
import org.springframework.cache.annotation.EnableCaching;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.data.redis.cache.RedisCacheManager;
import org.springframework.data.redis.serializer.GenericJacksonJsonRedisSerializer;
import org.springframework.data.redis.serializer.RedisSerializationContext;
import tools.jackson.databind.ObjectMapper;

/**
 * `@EnableCaching` turns on `@Cacheable`/`@CacheEvict`/`@Caching`
 * annotation processing project-wide. The actual `CacheManager` isn't
 * defined here as a bean — Boot's own `RedisCacheConfiguration`
 * auto-configures a `RedisCacheManager` (per `spring.cache.type: redis`
 * in application.yml), reusing the exact same Redis connection Phase 6
 * already wired up. No new caching technology, no new infra — see
 * phase-8-caching-and-rate-limiting/decisions.md.
 */
@Configuration
@EnableCaching
public class CacheConfig {

    /**
     * Without this, `RedisCacheManager`'s own default value serializer is
     * `JdkSerializationRedisSerializer` — plain Java serialization,
     * requiring every cached type to implement `Serializable`. This
     * project's DTOs are records that don't (and shouldn't have to), so
     * the very first cache write threw `NotSerializableException` —
     * caught by actually running `ScenarioCacheIntegrationTest`, not
     * assumed away. Fixed by swapping the value serializer to
     * `GenericJacksonJsonRedisSerializer` — the Jackson-3.x
     * (`tools.jackson`) one, matching this project's real, compile-scope
     * Jackson dependency (see common.json.JsonUtil's own Javadoc for why
     * the "2"-suffixed classic-Jackson variant is deliberately NOT used
     * here) — reusing the exact `ObjectMapper` bean Boot's own HTTP layer
     * already uses, so a cached response is byte-for-byte the same JSON
     * shape a live one would be.
     *
     * <p>{@code builder.cacheDefaults()} (read, not a fresh
     * {@code RedisCacheConfiguration}) is read BEFORE being modified and
     * set back, deliberately — Boot's own auto-configuration already
     * applied `spring.cache.redis.time-to-live` to it before any
     * `RedisCacheManagerBuilderCustomizer` bean runs; starting from a
     * brand new default config here would silently drop that TTL.
     */
    @Bean
    public RedisCacheManagerBuilderCustomizer jsonValueSerializerCustomizer(ObjectMapper objectMapper) {
        return (RedisCacheManager.RedisCacheManagerBuilder builder) -> builder.cacheDefaults(builder.cacheDefaults()
                .serializeValuesWith(RedisSerializationContext.SerializationPair.fromSerializer(
                        new GenericJacksonJsonRedisSerializer(objectMapper))));
    }
}
