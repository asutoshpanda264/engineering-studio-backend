package com.engineeringstudio.api.config;

import com.engineeringstudio.api.auth.JwtAuthFilter;
import com.engineeringstudio.api.auth.JwtService;
import com.engineeringstudio.api.common.ratelimit.RateLimitFilter;
import com.engineeringstudio.api.common.ratelimit.RateLimiter;
import java.util.List;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.annotation.method.configuration.EnableMethodSecurity;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.HttpStatusEntryPoint;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.cors.CorsConfigurationSource;
import org.springframework.web.cors.UrlBasedCorsConfigurationSource;

/**
 * The whole "guests browse/build freely, only submit requires auth" product
 * rule lives here as one line: everything is `permitAll()` except the
 * handful of paths that actually need it, rather than the more common
 * "authenticate everything, then carve out public exceptions" default. That
 * ordering is deliberate — it matches the product's actual shape (mostly
 * public reads, a few gated writes) instead of fighting it.
 *
 * `@EnableMethodSecurity` is what makes `@PreAuthorize("hasRole('ADMIN')")`
 * on individual controller methods work — that's the actual RBAC
 * enforcement point for admin/contributor-only actions, this filter chain
 * only handles the coarse "does this path need *any* authenticated user at
 * all" split.
 */
@Configuration
@EnableWebSecurity
@EnableMethodSecurity
public class SecurityConfig {

    @Bean
    public SecurityFilterChain filterChain(
            HttpSecurity http,
            JwtService jwtService,
            RateLimiter rateLimiter,
            RateLimitProperties rateLimitProperties,
            CorsConfigurationSource corsConfigurationSource,
            tools.jackson.databind.ObjectMapper objectMapper)
            throws Exception {
        http
                // Stateless JWT API, no server-side session/cookie to forge —
                // CSRF protection exists specifically to defend session-cookie
                // auth, so it's not just unnecessary here, it's protecting
                // against an attack this design doesn't have.
                .csrf(csrf -> csrf.disable())
                // The frontend (a separate origin — localhost:3000 in dev)
                // calls this API directly from the browser. Without this,
                // every call fails with an opaque CORS error the browser
                // never even shows as a real HTTP response — nothing to do
                // with auth or the request's own correctness. `allowCredentials`
                // stays false deliberately: the JWT travels in the
                // `Authorization` header, not a cookie, so there's no
                // credentialed-request concern this API actually has.
                .cors(cors -> cors.configurationSource(corsConfigurationSource))
                .sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .authorizeHttpRequests(auth -> auth
                        .requestMatchers("/auth/**", "/actuator/health").permitAll()
                        // /scenarios/drafts is NOT a public read despite
                        // matching the /scenarios/** wildcard below — listed
                        // first so Spring Security's first-match-wins
                        // ordering catches it before the broader rule would.
                        // @PreAuthorize on the controller method would also
                        // deny an unauthenticated caller here (method
                        // security runs independently of these path rules),
                        // but expressing the real intent at this layer too
                        // is worth the one extra line rather than leaning on
                        // the second layer alone to get it right.
                        .requestMatchers(org.springframework.http.HttpMethod.GET, "/scenarios/drafts")
                        .authenticated()
                        // Same carve-out, same reason: "my own rank" is
                        // user-specific data, not a public leaderboard
                        // read, despite matching /leaderboards/** below —
                        // listed first so it wins the first-match-wins
                        // ordering (Phase 6).
                        .requestMatchers(org.springframework.http.HttpMethod.GET, "/leaderboards/*/me")
                        .authenticated()
                        // Same carve-out again: "did I complete today's
                        // challenge" and "my completion history" are
                        // self-only, despite matching /daily-challenge/**
                        // below — listed first, same reason (Phase 7).
                        .requestMatchers(
                                org.springframework.http.HttpMethod.GET, "/daily-challenge/today/me", "/daily-challenge/history")
                        .authenticated()
                        // Public reads: scenario catalog, leaderboards, daily
                        // challenge — no login wall for browsing, per the
                        // product's existing "blank playground" principle.
                        .requestMatchers(org.springframework.http.HttpMethod.GET,
                                "/scenarios/**", "/leaderboards/**", "/daily-challenge/**").permitAll()
                        .anyRequest().authenticated())
                // Without this, Spring Security's default fallback
                // (Http403ForbiddenEntryPoint) returns 403 for BOTH "no
                // token at all" and "valid token, wrong role" — losing the
                // standard REST distinction between "who are you" (401) and
                // "I know who you are, you can't do this" (403). Explicit
                // here so an anonymous caller hitting an authenticated-only
                // endpoint gets 401; @PreAuthorize's AccessDeniedException
                // for a wrong-role authenticated caller still surfaces as
                // 403 by default, unaffected by this.
                .exceptionHandling(ex -> ex.authenticationEntryPoint(new HttpStatusEntryPoint(org.springframework.http.HttpStatus.UNAUTHORIZED)))
                .addFilterBefore(new JwtAuthFilter(jwtService), UsernamePasswordAuthenticationFilter.class)
                // After JwtAuthFilter deliberately — needs the
                // SecurityContext it just populated (for the per-user
                // /attempts/*/submit limit), and runs before Spring
                // Security's own authorization decision, so an over-limit
                // caller gets 429 before that decision (or the verify-service
                // call it could trigger) ever runs. See
                // common.ratelimit.RateLimitFilter's own Javadoc.
                .addFilterAfter(new RateLimitFilter(rateLimiter, rateLimitProperties, objectMapper), JwtAuthFilter.class);

        return http.build();
    }

    @Bean
    public CorsConfigurationSource corsConfigurationSource(CorsProperties corsProperties) {
        CorsConfiguration configuration = new CorsConfiguration();
        configuration.setAllowedOrigins(corsProperties.allowedOrigins());
        configuration.setAllowedMethods(List.of("GET", "POST", "PUT", "DELETE", "OPTIONS"));
        // Authorization: every authenticated call carries the JWT here.
        // Content-Type: every JSON request body needs it — and setting it
        // explicitly is exactly what turns a "simple" CORS request into a
        // preflighted one, so this list has to include it for POST/PUT
        // bodies to work at all, not just for completeness.
        configuration.setAllowedHeaders(List.of("Authorization", "Content-Type"));

        UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
        source.registerCorsConfiguration("/**", configuration);
        return source;
    }
}
