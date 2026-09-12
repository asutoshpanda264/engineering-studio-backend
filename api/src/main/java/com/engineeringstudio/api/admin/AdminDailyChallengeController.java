package com.engineeringstudio.api.admin;

import com.engineeringstudio.api.common.error.ApiException;
import com.engineeringstudio.api.dailychallenge.DailyChallengeService;
import com.engineeringstudio.api.dailychallenge.dto.AssignDailyChallengeRequest;
import jakarta.validation.Valid;
import java.time.LocalDate;
import java.time.format.DateTimeParseException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * The real, working half of the intended "admin curates the daily
 * challenge calendar" design — the other half (a dedicated challenge-setter
 * role, and a 10pm reminder notification when a future date is still
 * unset) is deliberately NOT built here: this project has no admin
 * workflow, no notification/email delivery, and no scheduler yet, so a
 * half-wired reminder pipeline with nothing real to notify would be worse
 * than being explicit that it's deferred. See
 * phase-7-daily-challenge-streaks/decisions.md.
 */
@RestController
@RequestMapping("/admin/daily-challenge")
public class AdminDailyChallengeController {

    private final DailyChallengeService dailyChallengeService;

    public AdminDailyChallengeController(DailyChallengeService dailyChallengeService) {
        this.dailyChallengeService = dailyChallengeService;
    }

    @PostMapping("/{date}")
    @PreAuthorize("hasRole('ADMIN')")
    public ResponseEntity<Void> assign(@PathVariable String date, @Valid @RequestBody AssignDailyChallengeRequest request) {
        LocalDate parsed;
        try {
            parsed = LocalDate.parse(date);
        } catch (DateTimeParseException e) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "Invalid date, expected yyyy-MM-dd: " + date);
        }
        dailyChallengeService.adminAssign(parsed, request.scenarioId());
        return ResponseEntity.noContent().build();
    }
}
