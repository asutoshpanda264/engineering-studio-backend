package com.engineeringstudio.api.auth;

import com.engineeringstudio.api.config.JwtProperties;
import io.jsonwebtoken.Claims;
import io.jsonwebtoken.JwtException;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Keys;
import java.security.Key;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Date;
import java.util.Optional;
import java.util.UUID;
import org.springframework.stereotype.Service;

/**
 * Handles ONLY the access token — a self-contained, stateless JWT that every
 * request's JwtAuthFilter can verify by signature alone, no DB hit needed.
 *
 * Deliberately does NOT handle refresh tokens: those are opaque random
 * strings (see AuthService/RefreshToken), not JWTs. A refresh token is
 * already validated against the database on every use (checking
 * revoked/expired), so wrapping it in a JWT would add parsing complexity for
 * zero benefit — the whole point of a JWT is *avoiding* a DB round-trip,
 * which doesn't apply to a token we look up in Postgres anyway.
 */
@Service
public class JwtService {

    private static final String ROLE_CLAIM = "role";

    private final Key signingKey;
    private final JwtProperties properties;
    private final Clock clock;

    public JwtService(JwtProperties properties, Clock clock) {
        this.properties = properties;
        this.clock = clock;
        this.signingKey = Keys.hmacShaKeyFor(properties.secret().getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }

    public String generateAccessToken(User user) {
        Instant now = clock.instant();
        Instant expiry = now.plus(Duration.ofMinutes(properties.accessTtlMinutes()));
        return Jwts.builder()
                .subject(user.getId().toString())
                .claim(ROLE_CLAIM, user.getRole().name())
                .issuedAt(Date.from(now))
                .expiration(Date.from(expiry))
                .signWith(signingKey)
                .compact();
    }

    /**
     * Returns empty rather than throwing on any parse/signature/expiry
     * failure — malformed or expired tokens are an expected, routine input
     * for an auth filter (every anonymous request without a token, every
     * request after a token expires), not exceptional program state.
     */
    public Optional<AccessTokenClaims> parse(String token) {
        try {
            Claims claims = Jwts.parser()
                    .verifyWith((javax.crypto.SecretKey) signingKey)
                    .build()
                    .parseSignedClaims(token)
                    .getPayload();
            UUID userId = UUID.fromString(claims.getSubject());
            Role role = Role.valueOf(claims.get(ROLE_CLAIM, String.class));
            return Optional.of(new AccessTokenClaims(userId, role));
        } catch (JwtException | IllegalArgumentException e) {
            return Optional.empty();
        }
    }

    public record AccessTokenClaims(UUID userId, Role role) {
    }
}
