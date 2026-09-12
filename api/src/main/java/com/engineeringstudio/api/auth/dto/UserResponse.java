package com.engineeringstudio.api.auth.dto;

import com.engineeringstudio.api.auth.Role;
import com.engineeringstudio.api.auth.User;
import java.time.LocalDate;
import java.util.UUID;

/**
 * currentStreak/longestStreak/lastSolveDate were on `User` since Phase 1
 * (see that entity's own Javadoc) but had no real logic behind them until
 * Phase 7's dailychallenge package started actually maintaining them —
 * added here now that they mean something.
 */
public record UserResponse(
        UUID id,
        String email,
        String displayName,
        Role role,
        int currentStreak,
        int longestStreak,
        LocalDate lastSolveDate) {
    public static UserResponse from(User user) {
        return new UserResponse(
                user.getId(),
                user.getEmail(),
                user.getDisplayName(),
                user.getRole(),
                user.getCurrentStreak(),
                user.getLongestStreak(),
                user.getLastSolveDate());
    }
}
