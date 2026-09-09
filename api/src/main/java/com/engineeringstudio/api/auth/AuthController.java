package com.engineeringstudio.api.auth;

import com.engineeringstudio.api.auth.dto.LoginRequest;
import com.engineeringstudio.api.auth.dto.RefreshRequest;
import com.engineeringstudio.api.auth.dto.RegisterRequest;
import com.engineeringstudio.api.auth.dto.TokenPairResponse;
import com.engineeringstudio.api.auth.dto.UserResponse;
import com.engineeringstudio.api.common.error.ApiException;
import jakarta.validation.Valid;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class AuthController {

    private final AuthService authService;
    private final UserRepository userRepository;

    public AuthController(AuthService authService, UserRepository userRepository) {
        this.authService = authService;
        this.userRepository = userRepository;
    }

    @PostMapping("/auth/register")
    public ResponseEntity<UserResponse> register(@Valid @RequestBody RegisterRequest request) {
        User user = authService.register(request);
        return ResponseEntity.status(HttpStatus.CREATED).body(UserResponse.from(user));
    }

    @PostMapping("/auth/login")
    public TokenPairResponse login(@Valid @RequestBody LoginRequest request) {
        return authService.login(request);
    }

    @PostMapping("/auth/refresh")
    public TokenPairResponse refresh(@Valid @RequestBody RefreshRequest request) {
        return authService.refresh(request.refreshToken());
    }

    @PostMapping("/auth/logout")
    public ResponseEntity<Void> logout(@Valid @RequestBody RefreshRequest request) {
        authService.logout(request.refreshToken());
        return ResponseEntity.noContent().build();
    }

    /**
     * Reads the userId JwtAuthFilter placed as the Authentication's
     * principal and re-fetches the full row — the JWT itself only carries
     * id+role (see JwtAuthFilter), so any endpoint needing more than that
     * (email, displayName, streak) does one lookup by primary key here
     * rather than bloating every access token with fields that go stale
     * the moment a user edits their profile.
     */
    @GetMapping("/me")
    public UserResponse me(Authentication authentication) {
        UUID userId = CurrentUser.id(authentication);
        User user = userRepository.findById(userId)
                .orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND, "User not found"));
        return UserResponse.from(user);
    }
}
