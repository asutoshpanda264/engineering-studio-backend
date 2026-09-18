package com.engineeringstudio.api.bugreport;

import com.engineeringstudio.api.auth.CurrentUser;
import com.engineeringstudio.api.bugreport.dto.BugReportRequest;
import com.engineeringstudio.api.bugreport.dto.BugReportResponse;
import com.engineeringstudio.api.bugreport.dto.BugReportReviewRequest;
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

/**
 * `/{id}/review` (a POST, not PATCH) mirrors `/scenarios/{id}/publish` and
 * `/contributions/{id}/approve` — this app's existing action-suffix
 * convention for a state-transition endpoint, and avoids adding PATCH to
 * `SecurityConfig`'s CORS `allowedMethods` for the sake of one endpoint.
 */
@RestController
@RequestMapping("/bug-reports")
public class BugReportController {

    private final BugReportService bugReportService;

    public BugReportController(BugReportService bugReportService) {
        this.bugReportService = bugReportService;
    }

    @PostMapping
    @PreAuthorize("isAuthenticated()")
    public ResponseEntity<BugReportResponse> file(
            @Valid @RequestBody BugReportRequest request, Authentication authentication) {
        BugReportResponse created = bugReportService.file(request, CurrentUser.id(authentication));
        return ResponseEntity.status(HttpStatus.CREATED).body(created);
    }

    @GetMapping
    @PreAuthorize("hasRole('ADMIN')")
    public List<BugReportResponse> listAll() {
        return bugReportService.listAll();
    }

    @PostMapping("/{id}/review")
    @PreAuthorize("hasRole('ADMIN')")
    public BugReportResponse review(@PathVariable UUID id, @Valid @RequestBody BugReportReviewRequest request) {
        return bugReportService.review(id, request);
    }
}
