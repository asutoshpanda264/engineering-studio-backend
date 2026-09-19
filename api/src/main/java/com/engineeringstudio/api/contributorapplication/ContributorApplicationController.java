package com.engineeringstudio.api.contributorapplication;

import com.engineeringstudio.api.auth.CurrentUser;
import com.engineeringstudio.api.contributorapplication.dto.ContributorApplicationResponse;
import com.engineeringstudio.api.contributorapplication.dto.TopContributorApplicationResponse;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/contributor-applications")
public class ContributorApplicationController {

    private final ContributorApplicationService applicationService;

    public ContributorApplicationController(ContributorApplicationService applicationService) {
        this.applicationService = applicationService;
    }

    /** Plain USER only — a CONTRIBUTOR/ADMIN already has (at least) that role, applying again doesn't mean anything. */
    @PostMapping
    @PreAuthorize("hasRole('USER')")
    public ResponseEntity<ContributorApplicationResponse> apply(Authentication authentication) {
        ContributorApplicationResponse created = applicationService.apply(CurrentUser.id(authentication));
        return ResponseEntity.status(HttpStatus.CREATED).body(created);
    }

    @GetMapping("/mine")
    @PreAuthorize("isAuthenticated()")
    public List<ContributorApplicationResponse> listMine(Authentication authentication) {
        return applicationService.listMine(CurrentUser.id(authentication));
    }

    @GetMapping("/top")
    @PreAuthorize("hasRole('ADMIN')")
    public List<TopContributorApplicationResponse> listTopPending() {
        return applicationService.listTopPending();
    }

    @PostMapping("/{id}/approve")
    @PreAuthorize("hasRole('ADMIN')")
    public ContributorApplicationResponse approve(@PathVariable UUID id, Authentication authentication) {
        return applicationService.approve(id, CurrentUser.id(authentication));
    }

    @PostMapping("/{id}/reject")
    @PreAuthorize("hasRole('ADMIN')")
    public ContributorApplicationResponse reject(@PathVariable UUID id, Authentication authentication) {
        return applicationService.reject(id, CurrentUser.id(authentication));
    }
}
