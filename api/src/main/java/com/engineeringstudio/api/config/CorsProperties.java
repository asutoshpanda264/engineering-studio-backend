package com.engineeringstudio.api.config;

import java.util.List;
import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * `app.cors.allowed-origins` — the frontend origin(s) allowed to call this
 * API cross-origin. Externalized rather than hard-coded (same reasoning as
 * every other `@ConfigurationProperties` record here) specifically because
 * this value MUST differ between local dev (`http://localhost:3000`) and
 * wherever the frontend is actually deployed — a wrong value here doesn't
 * fail loudly like a bad DB URL would, it just silently breaks every
 * browser call with an opaque CORS error nowhere near this file.
 */
@ConfigurationProperties(prefix = "app.cors")
public record CorsProperties(List<String> allowedOrigins) {
}
