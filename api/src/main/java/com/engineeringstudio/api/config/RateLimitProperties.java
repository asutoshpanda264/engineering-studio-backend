package com.engineeringstudio.api.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * `app.rate-limit.*` — one request budget per fixed 1-minute window, per
 * limited endpoint (see common.ratelimit.RateLimitFilter for which
 * endpoints and why). Externalized rather than hard-coded, same reasoning
 * as JwtProperties/VerifyServiceProperties: one place to tune without a
 * code change, validated as a group at startup.
 */
@ConfigurationProperties(prefix = "app.rate-limit")
public record RateLimitProperties(int authRequestsPerMinute, int submitRequestsPerMinute) {
}
