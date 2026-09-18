package com.engineeringstudio.api.contribution;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.engineeringstudio.api.auth.Role;
import com.engineeringstudio.api.auth.User;
import com.engineeringstudio.api.auth.UserRepository;
import com.engineeringstudio.api.auth.dto.LoginRequest;
import com.engineeringstudio.api.support.AbstractIntegrationTest;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.MediaType;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.test.web.servlet.MockMvc;

/**
 * Covers: submit -> pending queue (points-sorted) -> admin approve awards
 * fixed points -> re-approval conflicts -> shows up in "mine"; plus the
 * RBAC boundaries (only ADMIN sees/reviews the queue) and validation.
 */
class ContributionCrudIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private PasswordEncoder passwordEncoder;

    private final ObjectMapper objectMapper = new ObjectMapper();

    @Test
    void fullSubmitToApprovalLifecycleAwardsPoints() throws Exception {
        String contributorToken = registerAs("contrib1@example.com", Role.CONTRIBUTOR);
        String adminToken = registerAs("admin1@example.com", Role.ADMIN);

        String body = mockMvc.perform(post("/contributions")
                        .header("Authorization", "Bearer " + contributorToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(request("QUESTION", "A question", "Body text", null))))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.status").value("PENDING"))
                .andExpect(jsonPath("$.pointsAwarded").value(0))
                .andReturn().getResponse().getContentAsString();
        String id = objectMapper.readTree(body).get("id").asText();

        // Contributor role can't reach the review endpoints at all, own submission or not.
        mockMvc.perform(post("/contributions/" + id + "/approve").header("Authorization", "Bearer " + contributorToken))
                .andExpect(status().isForbidden());

        mockMvc.perform(get("/contributions/pending").header("Authorization", "Bearer " + adminToken))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].contribution.id").value(id))
                .andExpect(jsonPath("$[0].contributorApprovedPoints").value(0));

        mockMvc.perform(post("/contributions/" + id + "/approve").header("Authorization", "Bearer " + adminToken))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("APPROVED"))
                .andExpect(jsonPath("$.pointsAwarded").value(5));

        // Already reviewed — approving again conflicts.
        mockMvc.perform(post("/contributions/" + id + "/approve").header("Authorization", "Bearer " + adminToken))
                .andExpect(status().isConflict());

        // No longer in the pending queue.
        mockMvc.perform(get("/contributions/pending").header("Authorization", "Bearer " + adminToken))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$").isEmpty());

        mockMvc.perform(get("/contributions/mine").header("Authorization", "Bearer " + contributorToken))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].status").value("APPROVED"))
                .andExpect(jsonPath("$[0].pointsAwarded").value(5));
    }

    @Test
    void pendingQueueOrdersByContributorsApprovedPointsDescending() throws Exception {
        String strongToken = registerAs("strong@example.com", Role.CONTRIBUTOR);
        String weakToken = registerAs("weak@example.com", Role.CONTRIBUTOR);
        String adminToken = registerAs("admin2@example.com", Role.ADMIN);

        // Give "strong" one already-approved VLOG (15 points) before either submits their pending item.
        String approvedId = createAndGetId(strongToken, "VLOG", "Prior vlog", "Body", "https://example.com/v");
        mockMvc.perform(post("/contributions/" + approvedId + "/approve").header("Authorization", "Bearer " + adminToken))
                .andExpect(status().isOk());

        String weakPendingId = createAndGetId(weakToken, "QUESTION", "Weak's question", "Body", null);
        String strongPendingId = createAndGetId(strongToken, "POST", "Strong's post", "Body", null);

        mockMvc.perform(get("/contributions/pending").header("Authorization", "Bearer " + adminToken))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].contribution.id").value(strongPendingId))
                .andExpect(jsonPath("$[0].contributorApprovedPoints").value(15))
                .andExpect(jsonPath("$[1].contribution.id").value(weakPendingId))
                .andExpect(jsonPath("$[1].contributorApprovedPoints").value(0));
    }

    @Test
    void onlyAdminCanSeeOrReviewThePendingQueue() throws Exception {
        String contributorToken = registerAs("contrib2@example.com", Role.CONTRIBUTOR);
        createAndGetId(contributorToken, "POST", "A post", "Body text", null);

        mockMvc.perform(get("/contributions/pending").header("Authorization", "Bearer " + contributorToken))
                .andExpect(status().isForbidden());
        mockMvc.perform(get("/contributions/pending")).andExpect(status().isUnauthorized());
    }

    @Test
    void invalidRequestBodyFailsValidation() throws Exception {
        String contributorToken = registerAs("contrib3@example.com", Role.CONTRIBUTOR);
        Map<String, Object> invalid = new LinkedHashMap<>();
        invalid.put("category", "QUESTION");
        invalid.put("title", "");
        invalid.put("body", "Body text");

        mockMvc.perform(post("/contributions")
                        .header("Authorization", "Bearer " + contributorToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(invalid)))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.fieldErrors.title").exists());
    }

    private String createAndGetId(String token, String category, String title, String body, String link) throws Exception {
        String response = mockMvc.perform(post("/contributions")
                        .header("Authorization", "Bearer " + token)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(request(category, title, body, link))))
                .andExpect(status().isCreated())
                .andReturn().getResponse().getContentAsString();
        return objectMapper.readTree(response).get("id").asText();
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

    private Map<String, Object> request(String category, String title, String body, String link) {
        Map<String, Object> request = new LinkedHashMap<>();
        request.put("category", category);
        request.put("title", title);
        request.put("body", body);
        request.put("link", link);
        return request;
    }
}
