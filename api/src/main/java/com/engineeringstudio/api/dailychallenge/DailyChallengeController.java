package com.engineeringstudio.api.dailychallenge;

import com.engineeringstudio.api.auth.CurrentUser;
import com.engineeringstudio.api.dailychallenge.dto.DailyChallengeCompletionResponse;
import com.engineeringstudio.api.dailychallenge.dto.DailyChallengeResponse;
import com.engineeringstudio.api.dailychallenge.dto.MyDailyChallengeStandingResponse;
import com.engineeringstudio.api.scenario.Scenario;
import com.engineeringstudio.api.scenario.ScenarioRepository;
import java.util.List;
import java.util.UUID;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Public reads (today/a past date) except `/today/me` and `/history` —
 * same permitAll-plus-@PreAuthorize-override shape SecurityConfig already
 * uses for `GET /scenarios/drafts` (Phase 1) and `/leaderboards/*&#47;me`
 * (Phase 6): `/daily-challenge/**` GET has been permitAll since Phase 1,
 * before this package existed, so this phase only had to carve the two
 * self-only paths back out.
 */
@RestController
@RequestMapping("/daily-challenge")
public class DailyChallengeController {

    private final DailyChallengeService dailyChallengeService;
    private final ScenarioRepository scenarioRepository;

    public DailyChallengeController(DailyChallengeService dailyChallengeService, ScenarioRepository scenarioRepository) {
        this.dailyChallengeService = dailyChallengeService;
        this.scenarioRepository = scenarioRepository;
    }

    @GetMapping("/today")
    public DailyChallengeResponse today() {
        return toResponse(dailyChallengeService.getToday());
    }

    @GetMapping("/{date}")
    public DailyChallengeResponse forDate(@PathVariable String date) {
        return toResponse(dailyChallengeService.getForDate(DailyChallengeService.parseDate(date)));
    }

    @GetMapping("/today/me")
    @PreAuthorize("isAuthenticated()")
    public MyDailyChallengeStandingResponse mine(Authentication authentication) {
        UUID userId = CurrentUser.id(authentication);
        return new MyDailyChallengeStandingResponse(dailyChallengeService.today(), dailyChallengeService.hasUserCompletedToday(userId));
    }

    @GetMapping("/history")
    @PreAuthorize("isAuthenticated()")
    public List<DailyChallengeCompletionResponse> history(Authentication authentication) {
        UUID userId = CurrentUser.id(authentication);
        return dailyChallengeService.historyForUser(userId).stream()
                .map(DailyChallengeCompletionResponse::from)
                .toList();
    }

    private DailyChallengeResponse toResponse(DailyChallenge challenge) {
        Scenario scenario = scenarioRepository.findById(challenge.getScenarioId())
                .orElseThrow(() -> new IllegalStateException(
                        "daily_challenges references a missing scenario: " + challenge.getScenarioId()));
        return DailyChallengeResponse.of(challenge, scenario);
    }
}
