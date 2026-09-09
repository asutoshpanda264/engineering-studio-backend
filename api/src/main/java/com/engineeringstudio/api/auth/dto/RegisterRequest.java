package com.engineeringstudio.api.auth.dto;

import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/**
 * @Valid on the controller parameter triggers these checks automatically —
 * a malformed request never reaches AuthService, it 400s at the boundary
 * with a field-level error (see GlobalExceptionHandler).
 */
public record RegisterRequest(
        @NotBlank @Email String email,
        @NotBlank @Size(min = 8, max = 100) String password,
        @NotBlank @Size(min = 1, max = 100) String displayName) {
}
