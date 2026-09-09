package com.engineeringstudio.api.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Binds the `app.jwt.*` keys from application.yml. Using a typed
 * @ConfigurationProperties class instead of scattered @Value("${...}")
 * injections means these three settings live in exactly one place and are
 * validated as a group at startup (a missing/malformed value fails fast
 * instead of surfacing as a null somewhere deep in JwtService).
 *
 * Access tokens: 15 minutes. Short enough that a leaked access token has a
 * small blast radius, long enough that the frontend isn't refreshing on
 * every other request.
 * Refresh tokens: 30 days. Long-lived, but revocable (see RefreshToken) —
 * the whole reason a refresh token exists separately from the access token
 * is so a compromised session can be revoked without changing the user's
 * password.
 */
@ConfigurationProperties(prefix = "app.jwt")
public record JwtProperties(String secret, long accessTtlMinutes, long refreshTtlDays) {
}
