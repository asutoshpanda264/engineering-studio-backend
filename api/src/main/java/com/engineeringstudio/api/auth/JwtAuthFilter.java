package com.engineeringstudio.api.auth;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.List;
import org.springframework.lang.NonNull;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Runs once per request, before Spring Security's own auth machinery: reads
 * the `Authorization: Bearer <token>` header, and if it's a valid access
 * token, populates the SecurityContext so downstream @PreAuthorize checks
 * and `Authentication#getPrincipal()` have something to work with.
 *
 * No token, or an invalid/expired one, is NOT an error here — it just means
 * the request proceeds as anonymous, and it's whatever endpoint's own
 * authorization rule (in SecurityConfig, or @PreAuthorize) decides whether
 * that's allowed. This is what makes the "guests can build/run freely,
 * only submit requires auth" design work: most read endpoints have no auth
 * requirement at all, so an anonymous request reaching them is completely
 * normal, not something this filter should reject early.
 */
public class JwtAuthFilter extends OncePerRequestFilter {

    private static final String AUTH_HEADER = "Authorization";
    private static final String BEARER_PREFIX = "Bearer ";

    private final JwtService jwtService;

    public JwtAuthFilter(JwtService jwtService) {
        this.jwtService = jwtService;
    }

    @Override
    protected void doFilterInternal(
            @NonNull HttpServletRequest request,
            @NonNull HttpServletResponse response,
            @NonNull FilterChain filterChain) throws ServletException, IOException {

        String header = request.getHeader(AUTH_HEADER);
        if (header != null && header.startsWith(BEARER_PREFIX)) {
            String token = header.substring(BEARER_PREFIX.length());
            jwtService.parse(token).ifPresent(claims -> {
                var authority = new SimpleGrantedAuthority("ROLE_" + claims.role().name());
                var authentication = new UsernamePasswordAuthenticationToken(
                        claims.userId(), null, List.of(authority));
                SecurityContextHolder.getContext().setAuthentication(authentication);
            });
        }

        filterChain.doFilter(request, response);
    }
}
