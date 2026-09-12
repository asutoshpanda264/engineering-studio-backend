package com.engineeringstudio.api.admin;

import com.engineeringstudio.api.leaderboard.LeaderboardService;
import java.util.Map;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Wipes-and-repopulates every Redis leaderboard from `problem_progress`
 * (the real source of truth) — see leaderboard.LeaderboardService's
 * `rebuildAll` Javadoc for why this exists at all. No SecurityConfig
 * entry needed: `/admin/**` isn't in any explicit matcher, so it falls
 * through to the filter chain's `anyRequest().authenticated()` default,
 * same as AdminPingController — `@PreAuthorize` below is the actual
 * enforcement.
 */
@RestController
@RequestMapping("/admin/leaderboard")
public class AdminLeaderboardController {

    private final LeaderboardService leaderboardService;

    public AdminLeaderboardController(LeaderboardService leaderboardService) {
        this.leaderboardService = leaderboardService;
    }

    @PostMapping("/rebuild")
    @PreAuthorize("hasRole('ADMIN')")
    public Map<String, String> rebuild() {
        leaderboardService.rebuildAll();
        return Map.of("status", "rebuilt");
    }
}
