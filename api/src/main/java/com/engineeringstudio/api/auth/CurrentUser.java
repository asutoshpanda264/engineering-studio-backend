package com.engineeringstudio.api.auth;

import java.util.UUID;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.GrantedAuthority;

/**
 * Pulls the userId + Role back out of an authenticated request's
 * Authentication object — the same two pieces of data JwtAuthFilter put
 * there from the token's claims (see explain_auth.md). Every controller
 * that needs to know "who is calling, and what role do they have" (for
 * ownership checks a bare @PreAuthorize role expression can't express —
 * e.g. "a contributor may edit only their OWN scenarios") goes through
 * this rather than re-deriving it inline each time.
 */
public final class CurrentUser {

    private CurrentUser() {
    }

    public static UUID id(Authentication authentication) {
        return (UUID) authentication.getPrincipal();
    }

    public static Role role(Authentication authentication) {
        return authentication.getAuthorities().stream()
                .map(GrantedAuthority::getAuthority)
                .filter(a -> a.startsWith("ROLE_"))
                .map(a -> Role.valueOf(a.substring("ROLE_".length())))
                .findFirst()
                .orElseThrow(() -> new IllegalStateException("Authenticated request has no role authority"));
    }
}
