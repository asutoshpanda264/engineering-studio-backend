package com.engineeringstudio.api.scenario;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.engineeringstudio.api.auth.Role;
import com.engineeringstudio.api.auth.User;
import com.engineeringstudio.api.auth.UserRepository;
import com.engineeringstudio.api.auth.dto.LoginRequest;
import com.engineeringstudio.api.support.AbstractIntegrationTest;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.MediaType;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.test.web.servlet.MockMvc;

/**
 * Covers the M2 checkpoint: contributor-create → draft → admin-publish →
 * public listing → editing bumps version and snapshots the previous one →
 * RBAC boundaries (contributor can't edit someone else's draft, can't edit
 * once published, can't publish/archive/delete at all).
 */
class ScenarioCrudIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private PasswordEncoder passwordEncoder;

    private final ObjectMapper objectMapper = new ObjectMapper();

    @Test
    void fullDraftToPublishedLifecycleWithVersioning() throws Exception {
        String contributorToken = registerAs("contrib1@example.com", Role.CONTRIBUTOR);
        String adminToken = registerAs("admin1@example.com", Role.ADMIN);
        String scenarioId = "test-url-shortener";

        // Contributor creates a draft.
        mockMvc.perform(post("/scenarios")
                        .header("Authorization", "Bearer " + contributorToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(minimalRequest(scenarioId, "URL Shortener v1"))))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.status").value("DRAFT"))
                .andExpect(jsonPath("$.version").value(1));

        // Not visible on the public listing yet.
        mockMvc.perform(get("/scenarios/" + scenarioId))
                .andExpect(status().isNotFound());

        // A different, unauthenticated caller can't see it in the drafts list either.
        mockMvc.perform(get("/scenarios/drafts")).andExpect(status().isUnauthorized());

        // Admin publishes it.
        mockMvc.perform(post("/scenarios/" + scenarioId + "/publish").header("Authorization", "Bearer " + adminToken))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("PUBLISHED"));

        // Now it's public.
        mockMvc.perform(get("/scenarios/" + scenarioId))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.title").value("URL Shortener v1"));
        // Checks presence, not position — the 32 seeded scenarios (V2.1
        // migration) share this list, and findByStatus has no ORDER BY, so
        // asserting an index was never safe even before they existed.
        mockMvc.perform(get("/scenarios"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[?(@.id == '" + scenarioId + "')]").exists());

        // Once published, even the owning contributor can no longer edit it.
        mockMvc.perform(put("/scenarios/" + scenarioId)
                        .header("Authorization", "Bearer " + contributorToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(minimalRequest(scenarioId, "URL Shortener v2"))))
                .andExpect(status().isForbidden());

        // Admin edits it — version bumps, previous content snapshotted.
        mockMvc.perform(put("/scenarios/" + scenarioId)
                        .header("Authorization", "Bearer " + adminToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(minimalRequest(scenarioId, "URL Shortener v2"))))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.version").value(2))
                .andExpect(jsonPath("$.title").value("URL Shortener v2"));

        // Old version 1 content is still fetchable, unchanged.
        mockMvc.perform(get("/scenarios/" + scenarioId + "/versions/1"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.title").value("URL Shortener v1"));
        // Current version (2) resolves too, without needing its own snapshot row.
        mockMvc.perform(get("/scenarios/" + scenarioId + "/versions/2"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.title").value("URL Shortener v2"));
    }

    @Test
    void contributorCannotEditAnotherContributorsDraft() throws Exception {
        String ownerToken = registerAs("owner@example.com", Role.CONTRIBUTOR);
        String otherToken = registerAs("other@example.com", Role.CONTRIBUTOR);
        String id = "owned-draft";

        mockMvc.perform(post("/scenarios")
                        .header("Authorization", "Bearer " + ownerToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(minimalRequest(id, "Owned"))))
                .andExpect(status().isCreated());

        mockMvc.perform(put("/scenarios/" + id)
                        .header("Authorization", "Bearer " + otherToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(minimalRequest(id, "Hijacked"))))
                .andExpect(status().isForbidden());
    }

    @Test
    void onlyAdminCanPublishOrArchiveOrDelete() throws Exception {
        String contributorToken = registerAs("contrib2@example.com", Role.CONTRIBUTOR);
        String id = "rbac-check";

        mockMvc.perform(post("/scenarios")
                        .header("Authorization", "Bearer " + contributorToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(minimalRequest(id, "RBAC Check"))))
                .andExpect(status().isCreated());

        mockMvc.perform(post("/scenarios/" + id + "/publish").header("Authorization", "Bearer " + contributorToken))
                .andExpect(status().isForbidden());
        mockMvc.perform(delete("/scenarios/" + id).header("Authorization", "Bearer " + contributorToken))
                .andExpect(status().isForbidden());
    }

    @Test
    void publishingATwiceOrDeletingAPublishedScenarioConflicts() throws Exception {
        String adminToken = registerAs("admin2@example.com", Role.ADMIN);
        String id = "double-publish";

        mockMvc.perform(post("/scenarios")
                        .header("Authorization", "Bearer " + adminToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(minimalRequest(id, "Double Publish"))))
                .andExpect(status().isCreated());
        mockMvc.perform(post("/scenarios/" + id + "/publish").header("Authorization", "Bearer " + adminToken))
                .andExpect(status().isOk());

        mockMvc.perform(post("/scenarios/" + id + "/publish").header("Authorization", "Bearer " + adminToken))
                .andExpect(status().isConflict());
        mockMvc.perform(delete("/scenarios/" + id).header("Authorization", "Bearer " + adminToken))
                .andExpect(status().isConflict());
    }

    @Test
    void creatingWithADuplicateIdConflicts() throws Exception {
        String adminToken = registerAs("admin3@example.com", Role.ADMIN);
        String id = "dup-id";

        mockMvc.perform(post("/scenarios")
                        .header("Authorization", "Bearer " + adminToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(minimalRequest(id, "First"))))
                .andExpect(status().isCreated());

        mockMvc.perform(post("/scenarios")
                        .header("Authorization", "Bearer " + adminToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(minimalRequest(id, "Second"))))
                .andExpect(status().isConflict());
    }

    @Test
    void invalidRequestBodyFailsValidation() throws Exception {
        String adminToken = registerAs("admin4@example.com", Role.ADMIN);
        Map<String, Object> invalid = minimalRequest("bad-difficulty", "Bad");
        invalid.put("difficulty", 9); // out of 1..5 range

        mockMvc.perform(post("/scenarios")
                        .header("Authorization", "Bearer " + adminToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(invalid)))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.fieldErrors.difficulty").exists());
    }

    private String registerAs(String email, Role role) throws Exception {
        User user = User.builder()
                .email(email)
                .passwordHash(passwordEncoder.encode("supersecret1"))
                .displayName(email)
                .role(role)
                .build();
        userRepository.save(user);

        String body = mockMvc.perform(post("/auth/login")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(new LoginRequest(email, "supersecret1"))))
                .andExpect(status().isOk())
                .andReturn().getResponse().getContentAsString();
        return objectMapper.readTree(body).get("accessToken").asText();
    }

    private Map<String, Object> minimalRequest(String id, String title) {
        Map<String, Object> entity = new LinkedHashMap<>();
        entity.put("id", "client");
        entity.put("type", "client");
        entity.put("label", "Client");
        entity.put("position", Map.of("x", 0, "y", 0));
        entity.put("config", Map.of());

        Map<String, Object> constraint = new LinkedHashMap<>();
        constraint.put("id", "c1");
        constraint.put("metric", "successRate");
        constraint.put("comparator", "gte");
        constraint.put("threshold", 0.95);
        constraint.put("label", "Success rate");

        Map<String, Object> request = new LinkedHashMap<>();
        request.put("id", id);
        request.put("title", title);
        request.put("difficulty", 3);
        request.put("topics", List.of("caching"));
        request.put("story", "A business problem needing a solution.");
        request.put("startingEntities", List.of(entity));
        request.put("startingConnections", List.of());
        request.put("trafficPattern", Map.of("type", "constant", "rate", 10));
        request.put("durationMs", 60000);
        request.put("seed", 42);
        request.put("constraints", List.of(constraint));
        request.put("hints", List.of("Think about caching"));
        request.put("learningGoals", List.of("Understand caching"));
        request.put("requiresGatedToolCalls", false);
        return request;
    }
}
