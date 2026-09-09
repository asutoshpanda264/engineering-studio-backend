package com.engineeringstudio.api.progress;

import com.engineeringstudio.api.auth.CurrentUser;
import com.engineeringstudio.api.common.error.ApiException;
import com.engineeringstudio.api.progress.dto.ProblemProgressResponse;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** Self-only — no admin bypass here (unlike Attempt's GET), per the plan: this is a user's own dashboard data, not a support/moderation view. */
@RestController
@RequestMapping("/progress/scenarios")
public class ProblemProgressController {

    private final ProblemProgressRepository problemProgressRepository;

    public ProblemProgressController(ProblemProgressRepository problemProgressRepository) {
        this.problemProgressRepository = problemProgressRepository;
    }

    @GetMapping
    public List<ProblemProgressResponse> listMine(Authentication authentication) {
        UUID userId = CurrentUser.id(authentication);
        return problemProgressRepository.findByUserId(userId).stream()
                .map(ProblemProgressResponse::from)
                .toList();
    }

    @GetMapping("/{scenarioId}")
    public ProblemProgressResponse getMine(@PathVariable String scenarioId, Authentication authentication) {
        UUID userId = CurrentUser.id(authentication);
        return problemProgressRepository.findByUserIdAndScenarioId(userId, scenarioId)
                .map(ProblemProgressResponse::from)
                .orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND, "No progress recorded for this scenario yet"));
    }
}
