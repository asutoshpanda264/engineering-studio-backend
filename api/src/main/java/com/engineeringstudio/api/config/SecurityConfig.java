package com.engineeringstudio.api.config;

import com.engineeringstudio.api.auth.JwtAuthFilter;
import com.engineeringstudio.api.auth.JwtService;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.annotation.method.configuration.EnableMethodSecurity;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.HttpStatusEntryPoint;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;

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
    public SecurityFilterChain filterChain(HttpSecurity http, JwtService jwtService) throws Exception {
        http
                // Stateless JWT API, no server-side session/cookie to forge —
                // CSRF protection exists specifically to defend session-cookie
                // auth, so it's not just unnecessary here, it's protecting
                // against an attack this design doesn't have.
                .csrf(csrf -> csrf.disable())
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
                .addFilterBefore(new JwtAuthFilter(jwtService), UsernamePasswordAuthenticationFilter.class);

        return http.build();
    }
}
