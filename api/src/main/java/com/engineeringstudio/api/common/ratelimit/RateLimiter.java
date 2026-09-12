package com.engineeringstudio.api.common.ratelimit;

import java.time.Duration;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;

/**
 * A fixed-window counter, hand-rolled directly against `StringRedisTemplate`
 * (Redis `INCR` + `EXPIRE`) rather than a rate-limiting library — same
 * "explain the actual mechanism" choice this project already made for the
 * Phase 6 leaderboards (hand-rolled ZSET operations, not a library) and
 * for good reason here specifically: the whole mechanism is two Redis
 * commands, well understood, and reuses infrastructure (Redis) already in
 * this project rather than adding a new dependency to pin/verify. See
 * decisions.md for the fixed-window-vs-sliding-window trade-off this
 * accepts.
 */
@Component
public class RateLimiter {

    private final StringRedisTemplate redisTemplate;

    public RateLimiter(StringRedisTemplate redisTemplate) {
        this.redisTemplate = redisTemplate;
    }

    /**
     * Increments `key`'s count for its current window, setting the
     * window's TTL only on the FIRST increment (`count == 1`) — every
     * later call in that same window just increments, leaving the
     * original expiry alone, so the window is genuinely fixed-length from
     * whenever the first request in it landed, not continually pushed
     * back by later requests. Returns whether THIS call is still within
     * `limit` for the current window.
     */
    public boolean allow(String key, int limit, Duration window) {
        Long count = redisTemplate.opsForValue().increment(key);
        if (count != null && count == 1L) {
            redisTemplate.expire(key, window);
        }
        return count != null && count <= limit;
    }
}
