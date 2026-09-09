package com.engineeringstudio.api.attempt;

import com.engineeringstudio.api.attempt.dto.AttemptResponse;
import com.engineeringstudio.api.attempt.dto.StartAttemptRequest;
import com.engineeringstudio.api.attempt.dto.SubmitAttemptRequest;
import com.engineeringstudio.api.auth.CurrentUser;
import jakarta.validation.Valid;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * No @PreAuthorize role checks here — any authenticated user (USER,
 * CONTRIBUTOR, or ADMIN) may start/pause/resume/submit their OWN attempts.
 * `/attempts/**` isn't in SecurityConfig's public-GET allowlist, so the
 * filter chain's default `anyRequest().authenticated()` already requires a
 * valid token for everything in this controller — the only finer-grained
 * check left is ownership, which AttemptService enforces per-attempt.
 */
@RestController
@RequestMapping("/attempts")
public class AttemptController {

    private final AttemptService attemptService;

    public AttemptController(AttemptService attemptService) {
        this.attemptService = attemptService;
    }

    @PostMapping
    public ResponseEntity<AttemptResponse> start(
            @Valid @RequestBody StartAttemptRequest request, Authentication authentication) {
        AttemptResponse created = attemptService.start(request, CurrentUser.id(authentication));
        return ResponseEntity.status(HttpStatus.CREATED).body(created);
    }

    @PostMapping("/{id}/pause")
    public AttemptResponse pause(@PathVariable UUID id, Authentication authentication) {
        return attemptService.pause(id, CurrentUser.id(authentication));
    }

    @PostMapping("/{id}/resume")
    public AttemptResponse resume(@PathVariable UUID id, Authentication authentication) {
        return attemptService.resume(id, CurrentUser.id(authentication));
    }

    @PostMapping("/{id}/submit")
    public AttemptResponse submit(
            @PathVariable UUID id, @Valid @RequestBody SubmitAttemptRequest request, Authentication authentication) {
        return attemptService.submit(id, request, CurrentUser.id(authentication));
    }

    @GetMapping("/{id}")
    public AttemptResponse get(@PathVariable UUID id, Authentication authentication) {
        return attemptService.get(id, CurrentUser.id(authentication), CurrentUser.role(authentication));
    }

    @GetMapping
    public List<AttemptResponse> listMine(Authentication authentication) {
        return attemptService.listMine(CurrentUser.id(authentication));
    }
}
