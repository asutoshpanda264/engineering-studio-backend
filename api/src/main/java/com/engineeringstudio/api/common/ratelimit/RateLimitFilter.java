package com.engineeringstudio.api.common.ratelimit;

import com.engineeringstudio.api.common.error.ApiError;
import com.engineeringstudio.api.config.RateLimitProperties;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.time.Duration;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.lang.NonNull;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.util.AntPathMatcher;
import org.springframework.web.filter.OncePerRequestFilter;
import tools.jackson.databind.ObjectMapper;

/**
 * A plain class, not a `@Component` — constructed manually and wired into
 * the filter chain from `SecurityConfig`, the exact same shape as
 * `JwtAuthFilter`. Registered with `.addFilterAfter(..., JwtAuthFilter.class)`
 * deliberately: it needs `SecurityContextHolder`'s Authentication already
 * populated (for the per-user `/attempts/*&#47;submit` limit) but wants to
 * run BEFORE Spring Security's own authorization decision, so an
 * over-limit caller gets a 429 without that decision (or the controller,
 * or the verify-service call it would have triggered) ever running.
 *
 * <p>Only two rules exist, both fixed 1-minute windows via
 * {@link RateLimiter} — see decisions.md for why these two endpoints and
 * not a blanket limit on everything:
 * <ul>
 *   <li>`POST /auth/login`, `POST /auth/register` — per CLIENT IP
 *   (`request.getRemoteAddr()`, not `X-Forwarded-For` — this project has
 *   no reverse proxy in front of it today; see decisions.md). Brute-force/
 *   credential-stuffing protection on the two endpoints that don't need a
 *   valid token to hit at all.</li>
 *   <li>`POST /attempts/{id}/submit` — per AUTHENTICATED USER, only when
 *   one is actually present. An unauthenticated submit call is rejected by
 *   Spring Security's own 401 a few filters later anyway, at negligible
 *   cost — there's nothing expensive to protect for a caller who was never
 *   going to reach `AttemptService.submit` (and its real verify-service
 *   HTTP call) in the first place.</li>
 * </ul>
 */
public class RateLimitFilter extends OncePerRequestFilter {

    private static final Duration WINDOW = Duration.ofMinutes(1);
    private static final AntPathMatcher SUBMIT_PATH_MATCHER = new AntPathMatcher();
    private static final String SUBMIT_PATH_PATTERN = "/attempts/*/submit";

    private final RateLimiter rateLimiter;
    private final RateLimitProperties properties;
    private final ObjectMapper objectMapper;

    public RateLimitFilter(RateLimiter rateLimiter, RateLimitProperties properties, ObjectMapper objectMapper) {
        this.rateLimiter = rateLimiter;
        this.properties = properties;
        this.objectMapper = objectMapper;
    }

    @Override
    protected void doFilterInternal(
            @NonNull HttpServletRequest request,
            @NonNull HttpServletResponse response,
            @NonNull FilterChain filterChain) throws ServletException, IOException {

        String key = null;
        int limit = 0;

        if (isPost(request) && isAuthEndpoint(request)) {
            key = "ratelimit:auth-ip:" + request.getRemoteAddr();
            limit = properties.authRequestsPerMinute();
        } else if (isPost(request) && SUBMIT_PATH_MATCHER.match(SUBMIT_PATH_PATTERN, request.getRequestURI())) {
            UUID userId = currentUserIdOrNull();
            if (userId != null) {
                key = "ratelimit:submit-user:" + userId;
                limit = properties.submitRequestsPerMinute();
            }
        }

        if (key != null && !rateLimiter.allow(key, limit, WINDOW)) {
            respondTooManyRequests(response);
            return;
        }

        filterChain.doFilter(request, response);
    }

    private boolean isPost(HttpServletRequest request) {
        return "POST".equalsIgnoreCase(request.getMethod());
    }

    private boolean isAuthEndpoint(HttpServletRequest request) {
        String uri = request.getRequestURI();
        return "/auth/login".equals(uri) || "/auth/register".equals(uri);
    }

    /** Null, not a thrown exception, for anonymous/unauthenticated requests — CurrentUser.id() assumes an already-authenticated caller, which isn't guaranteed this early in the chain. */
    private UUID currentUserIdOrNull() {
        Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
        if (authentication != null && authentication.getPrincipal() instanceof UUID userId) {
            return userId;
        }
        return null;
    }

    private void respondTooManyRequests(HttpServletResponse response) throws IOException {
        response.setStatus(HttpStatus.TOO_MANY_REQUESTS.value());
        response.setHeader("Retry-After", String.valueOf(WINDOW.toSeconds()));
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        ApiError body = ApiError.of(
                HttpStatus.TOO_MANY_REQUESTS.value(),
                HttpStatus.TOO_MANY_REQUESTS.getReasonPhrase(),
                "Too many requests — try again in a minute.");
        response.getWriter().write(objectMapper.writeValueAsString(body));
    }
}
