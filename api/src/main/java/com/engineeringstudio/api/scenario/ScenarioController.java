package com.engineeringstudio.api.scenario;

import com.engineeringstudio.api.auth.CurrentUser;
import com.engineeringstudio.api.scenario.dto.ScenarioRequest;
import com.engineeringstudio.api.scenario.dto.ScenarioResponse;
import jakarta.validation.Valid;
import java.util.List;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Note on `/scenarios/drafts`: listed in the original plan doc as
 * `/scenarios/{id}/drafts`, which doesn't actually make sense (drafts
 * aren't scoped to one existing scenario id — you're listing draft
 * scenarios themselves). Implemented here as the sensible reading,
 * `/scenarios/drafts`, a minor correction over what was written down.
 */
@RestController
@RequestMapping("/scenarios")
public class ScenarioController {

    private final ScenarioService scenarioService;

    public ScenarioController(ScenarioService scenarioService) {
        this.scenarioService = scenarioService;
    }

    @GetMapping
    public List<ScenarioResponse> listPublished() {
        return scenarioService.listPublished();
    }

    @GetMapping("/drafts")
    @PreAuthorize("hasAnyRole('ADMIN', 'CONTRIBUTOR')")
    public List<ScenarioResponse> listDrafts(Authentication authentication) {
        return scenarioService.listDrafts(CurrentUser.id(authentication), CurrentUser.role(authentication));
    }

    @GetMapping("/{id}")
    public ScenarioResponse getPublished(@PathVariable String id) {
        return scenarioService.getPublished(id);
    }

    @GetMapping("/{id}/versions/{version}")
    public Map<String, Object> getVersion(@PathVariable String id, @PathVariable int version) {
        return scenarioService.getVersion(id, version);
    }

    @PostMapping
    @PreAuthorize("hasAnyRole('ADMIN', 'CONTRIBUTOR')")
    public ResponseEntity<ScenarioResponse> create(
            @Valid @RequestBody ScenarioRequest request, Authentication authentication) {
        ScenarioResponse created = scenarioService.createDraft(request, CurrentUser.id(authentication));
        return ResponseEntity.status(HttpStatus.CREATED).body(created);
    }

    @PutMapping("/{id}")
    @PreAuthorize("hasAnyRole('ADMIN', 'CONTRIBUTOR')")
    public ScenarioResponse update(
            @PathVariable String id, @Valid @RequestBody ScenarioRequest request, Authentication authentication) {
        return scenarioService.update(id, request, CurrentUser.id(authentication), CurrentUser.role(authentication));
    }

    @PostMapping("/{id}/publish")
    @PreAuthorize("hasRole('ADMIN')")
    public ScenarioResponse publish(@PathVariable String id) {
        return scenarioService.publish(id);
    }

    @PostMapping("/{id}/archive")
    @PreAuthorize("hasRole('ADMIN')")
    public ScenarioResponse archive(@PathVariable String id) {
        return scenarioService.archive(id);
    }

    @DeleteMapping("/{id}")
    @PreAuthorize("hasRole('ADMIN')")
    public ResponseEntity<Void> delete(@PathVariable String id) {
        scenarioService.delete(id);
        return ResponseEntity.noContent().build();
    }
}
