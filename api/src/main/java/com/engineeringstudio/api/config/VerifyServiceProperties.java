package com.engineeringstudio.api.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * `app.verify-service.*` — where engineering-studio-verify lives, and how
 * long to wait for it. 10s timeout / no retry is the deliberate policy
 * from the approved plan: a submit that can't be verified rolls back and
 * lands the attempt in VERIFY_FAILED rather than hanging indefinitely or
 * silently retrying a request whose side effects (if any ever exist on
 * the verify-service side) aren't naturally idempotent to retry blindly.
 */
@ConfigurationProperties(prefix = "app.verify-service")
public record VerifyServiceProperties(String baseUrl, long timeoutSeconds) {
}
