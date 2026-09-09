package com.engineeringstudio.api.auth.dto;

import com.engineeringstudio.api.auth.Role;
import com.engineeringstudio.api.auth.User;
import java.util.UUID;

public record UserResponse(UUID id, String email, String displayName, Role role) {
    public static UserResponse from(User user) {
        return new UserResponse(user.getId(), user.getEmail(), user.getDisplayName(), user.getRole());
    }
}
