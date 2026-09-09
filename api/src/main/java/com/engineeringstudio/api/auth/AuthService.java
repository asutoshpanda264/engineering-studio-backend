package com.engineeringstudio.api.auth;

import com.engineeringstudio.api.auth.dto.LoginRequest;
import com.engineeringstudio.api.auth.dto.RegisterRequest;
import com.engineeringstudio.api.auth.dto.TokenPairResponse;
import com.engineeringstudio.api.common.error.ApiException;
import com.engineeringstudio.api.config.JwtProperties;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.time.Clock;
import java.time.Duration;
import java.util.Base64;
import org.springframework.http.HttpStatus;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Owns the whole login lifecycle. Deliberately does NOT go through Spring
 * Security's AuthenticationManager/UserDetailsService — that machinery is
 * built for form-login/session flows where Security itself decides
 * "authenticated or not" for every request. Here, authentication only
 * happens at two points we control directly (login, refresh) and the
 * result is a token, not a session — so a plain password check against
 * PasswordEncoder is simpler and just as correct. (See decisions.md.)
 */
@Service
public class AuthService {

    private static final SecureRandom SECURE_RANDOM = new SecureRandom();

    private final UserRepository userRepository;
    private final RefreshTokenRepository refreshTokenRepository;
    private final PasswordEncoder passwordEncoder;
    private final JwtService jwtService;
    private final JwtProperties jwtProperties;
    private final Clock clock;

    public AuthService(
            UserRepository userRepository,
            RefreshTokenRepository refreshTokenRepository,
            PasswordEncoder passwordEncoder,
            JwtService jwtService,
            JwtProperties jwtProperties,
            Clock clock) {
        this.userRepository = userRepository;
        this.refreshTokenRepository = refreshTokenRepository;
        this.passwordEncoder = passwordEncoder;
        this.jwtService = jwtService;
        this.jwtProperties = jwtProperties;
        this.clock = clock;
    }

    @Transactional
    public User register(RegisterRequest request) {
        if (userRepository.existsByEmail(request.email())) {
            throw new ApiException(HttpStatus.CONFLICT, "An account with this email already exists");
        }
        User user = User.builder()
                .email(request.email())
                .passwordHash(passwordEncoder.encode(request.password()))
                .displayName(request.displayName())
                .role(Role.USER)
                .build();
        return userRepository.save(user);
    }

    @Transactional
    public TokenPairResponse login(LoginRequest request) {
        User user = userRepository.findByEmail(request.email())
                .orElseThrow(() -> new ApiException(HttpStatus.UNAUTHORIZED, "Invalid email or password"));

        if (!passwordEncoder.matches(request.password(), user.getPasswordHash())) {
            throw new ApiException(HttpStatus.UNAUTHORIZED, "Invalid email or password");
        }

        return issueTokenPair(user);
    }

    /**
     * Refresh-token ROTATION: the presented token is revoked and a brand
     * new one issued on every use, never just re-validated and reused. If a
     * refresh token is ever stolen, the legitimate user's next real refresh
     * fails (their token was already revoked by the thief's use) — which is
     * a visible signal something is wrong, instead of both parties silently
     * sharing one long-lived token indefinitely.
     */
    @Transactional
    public TokenPairResponse refresh(String rawRefreshToken) {
        String hash = hash(rawRefreshToken);
        RefreshToken token = refreshTokenRepository.findByTokenHash(hash)
                .orElseThrow(() -> new ApiException(HttpStatus.UNAUTHORIZED, "Invalid refresh token"));

        if (!token.isActive(clock.instant())) {
            throw new ApiException(HttpStatus.UNAUTHORIZED, "Refresh token expired or revoked");
        }

        token.setRevokedAt(clock.instant());
        refreshTokenRepository.save(token);

        return issueTokenPair(token.getUser());
    }

    @Transactional
    public void logout(String rawRefreshToken) {
        String hash = hash(rawRefreshToken);
        refreshTokenRepository.findByTokenHash(hash).ifPresent(token -> {
            token.setRevokedAt(clock.instant());
            refreshTokenRepository.save(token);
        });
        // Silently no-ops on an unknown/already-revoked token — logout is
        // idempotent by design, calling it twice isn't an error.
    }

    private TokenPairResponse issueTokenPair(User user) {
        String accessToken = jwtService.generateAccessToken(user);

        String rawRefreshToken = generateOpaqueToken();
        RefreshToken refreshToken = RefreshToken.builder()
                .user(user)
                .tokenHash(hash(rawRefreshToken))
                .expiresAt(clock.instant().plus(Duration.ofDays(jwtProperties.refreshTtlDays())))
                .build();
        refreshTokenRepository.save(refreshToken);

        return new TokenPairResponse(accessToken, rawRefreshToken);
    }

    private static String generateOpaqueToken() {
        byte[] bytes = new byte[32];
        SECURE_RANDOM.nextBytes(bytes);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    /**
     * SHA-256, not BCrypt, for refresh-token hashing — see AppConfig's
     * PasswordEncoder comment. The token itself is 256 bits of
     * SecureRandom output, already unguessable; hashing it here is only to
     * avoid storing the literal bearer token in the database, not to slow
     * down brute-forcing (there's nothing to brute-force against 256 bits
     * of entropy). A fast deterministic hash is the right tool for "does
     * this presented token match a stored record."
     */
    private static String hash(String value) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hashed = digest.digest(value.getBytes(StandardCharsets.UTF_8));
            return Base64.getEncoder().encodeToString(hashed);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 not available", e);
        }
    }
}
