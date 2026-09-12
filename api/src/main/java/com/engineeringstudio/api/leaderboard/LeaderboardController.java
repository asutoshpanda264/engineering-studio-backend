package com.engineeringstudio.api.leaderboard;

import com.engineeringstudio.api.auth.CurrentUser;
import com.engineeringstudio.api.common.error.ApiException;
import com.engineeringstudio.api.leaderboard.dto.LeaderboardEntryResponse;
import com.engineeringstudio.api.leaderboard.dto.MyLeaderboardStandingResponse;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Public reads except `/me` — see SecurityConfig, which already carved
 * out `/leaderboards/**` as a public GET path back in Phase 1 (browsing
 * a leaderboard needs no login), with `/leaderboards/*&#47;me`
 * special-cased back to authenticated-only, the same
 * permitAll-path-plus-@PreAuthorize-override pattern already used for
 * `GET /scenarios/drafts`.
 */
@RestController
@RequestMapping("/leaderboards")
public class LeaderboardController {

    private static final int DEFAULT_LIMIT = 20;
    private static final int MAX_LIMIT = 100;

    private final LeaderboardService leaderboardService;

    public LeaderboardController(LeaderboardService leaderboardService) {
        this.leaderboardService = leaderboardService;
    }

    @GetMapping("/{type}")
    public List<LeaderboardEntryResponse> top(
            @PathVariable String type, @RequestParam(defaultValue = "" + DEFAULT_LIMIT) int limit) {
        if (limit < 1 || limit > MAX_LIMIT) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "limit must be between 1 and " + MAX_LIMIT);
        }
        return leaderboardService.topN(LeaderboardType.fromSlug(type), limit);
    }

    @GetMapping("/{type}/me")
    @PreAuthorize("isAuthenticated()")
    public MyLeaderboardStandingResponse mine(@PathVariable String type, Authentication authentication) {
        UUID userId = CurrentUser.id(authentication);
        return leaderboardService.myStanding(LeaderboardType.fromSlug(type), userId);
    }
}
