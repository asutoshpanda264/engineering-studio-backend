package com.engineeringstudio.api.contribution;

import com.engineeringstudio.api.auth.CurrentUser;
import com.engineeringstudio.api.contribution.dto.ContributionRequest;
import com.engineeringstudio.api.contribution.dto.ContributionResponse;
import com.engineeringstudio.api.contribution.dto.PendingContributionResponse;
import jakarta.validation.Valid;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/contributions")
public class ContributionController {

    private final ContributionService contributionService;

    public ContributionController(ContributionService contributionService) {
        this.contributionService = contributionService;
    }

    @PostMapping
    @PreAuthorize("hasAnyRole('ADMIN', 'CONTRIBUTOR')")
    public ResponseEntity<ContributionResponse> submit(
            @Valid @RequestBody ContributionRequest request, Authentication authentication) {
        ContributionResponse created = contributionService.submit(request, CurrentUser.id(authentication));
        return ResponseEntity.status(HttpStatus.CREATED).body(created);
    }

    @GetMapping("/mine")
    @PreAuthorize("hasAnyRole('ADMIN', 'CONTRIBUTOR')")
    public List<ContributionResponse> listMine(Authentication authentication) {
        return contributionService.listMine(CurrentUser.id(authentication));
    }

    @GetMapping("/pending")
    @PreAuthorize("hasRole('ADMIN')")
    public List<PendingContributionResponse> listPending() {
        return contributionService.listPending();
    }

    @PostMapping("/{id}/approve")
    @PreAuthorize("hasRole('ADMIN')")
    public ContributionResponse approve(@PathVariable UUID id, Authentication authentication) {
        return contributionService.approve(id, CurrentUser.id(authentication));
    }

    @PostMapping("/{id}/reject")
    @PreAuthorize("hasRole('ADMIN')")
    public ContributionResponse reject(@PathVariable UUID id, Authentication authentication) {
        return contributionService.reject(id, CurrentUser.id(authentication));
    }
}
