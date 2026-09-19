package com.engineeringstudio.api.contributorapplication;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.engineeringstudio.api.attempt.AttemptMode;
import com.engineeringstudio.api.auth.Role;
import com.engineeringstudio.api.auth.User;
import com.engineeringstudio.api.auth.UserRepository;
import com.engineeringstudio.api.auth.dto.LoginRequest;
import com.engineeringstudio.api.common.json.JsonUtil;
import com.engineeringstudio.api.points.PointsLedgerRepository;
import com.engineeringstudio.api.scenario.Scenario;
import com.engineeringstudio.api.scenario.ScenarioRepository;
import com.engineeringstudio.api.scenario.ScenarioStatus;
import com.engineeringstudio.api.support.AbstractIntegrationTest;
import com.engineeringstudio.api.support.FakeVerifyClient;
import com.engineeringstudio.api.support.TestServiceOverridesConfig;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.test.web.servlet.MockMvc;

/**
 * Covers: apply -> shows in the admin's top-5 with real stats -> approve
 * promotes the role -> a promoted user's later solves no longer touch
 * progress/points (the anti-cheat freeze) -> RBAC boundaries -> duplicate
 * pending application conflicts -> priority ordering -> only 5 shown even
 * when more are pending.
 */
@Import(TestServiceOverridesConfig.class)
class ContributorApplicationCrudIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private ScenarioRepository scenarioRepository;

    @Autowired
    private PasswordEncoder passwordEncoder;

    @Autowired
    private FakeVerifyClient fakeVerifyClient;

    @Autowired
    private PointsLedgerRepository pointsLedgerRepository;

    private final ObjectMapper objectMapper = new ObjectMapper();

    @BeforeEach
    void resetFakeVerifyClient() {
        fakeVerifyClient.reset();
    }

    @Test
    void applyShowsInTopQueueAndApprovalPromotesTheRole() throws Exception {
        String applicantEmail = "applicant1@example.com";
        String applicantToken = registerAs(applicantEmail, Role.USER);
        String adminToken = registerAs("admin1@example.com", Role.ADMIN);

        String body = mockMvc.perform(post("/contributor-applications").header("Authorization", "Bearer " + applicantToken))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.status").value("PENDING"))
                .andReturn().getResponse().getContentAsString();
        String applicationId = objectMapper.readTree(body).get("id").asText();

        // A fresh user with no solves at all still shows up, with zeroed stats.
        mockMvc.perform(get("/contributor-applications/top").header("Authorization", "Bearer " + adminToken))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].application.id").value(applicationId))
                .andExpect(jsonPath("$[0].applicantDisplayName").value(applicantEmail))
                .andExpect(jsonPath("$[0].solvedCount").value(0))
                .andExpect(jsonPath("$[0].totalPoints").value(0))
                .andExpect(jsonPath("$[0].currentStreak").value(0))
                .andExpect(jsonPath("$[0].priorityScore").value(0));

        // Applying again while one is already pending conflicts.
        mockMvc.perform(post("/contributor-applications").header("Authorization", "Bearer " + applicantToken))
                .andExpect(status().isConflict());

        mockMvc.perform(post("/contributor-applications/" + applicationId + "/approve")
                        .header("Authorization", "Bearer " + adminToken))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("APPROVED"));

        // The role change is real — a FRESH token (re-login) reflects it,
        // per the documented JWT-staleness trade-off (industry.md).
        String refreshedToken = login(applicantEmail);
        mockMvc.perform(get("/me").header("Authorization", "Bearer " + refreshedToken))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.role").value("CONTRIBUTOR"));

        // No longer in the pending queue.
        mockMvc.perform(get("/contributor-applications/top").header("Authorization", "Bearer " + adminToken))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$").isEmpty());
    }

    @Test
    void aPromotedContributorsLaterSolvesDoNotTouchProgressOrPoints() throws Exception {
        String applicantEmail = "soon-contributor@example.com";
        String applicantToken = registerAs(applicantEmail, Role.USER);
        String adminToken = registerAs("admin2@example.com", Role.ADMIN);
        publishScenario("freeze-check-scenario");

        String applicationId = apply(applicantToken);
        mockMvc.perform(post("/contributor-applications/" + applicationId + "/approve")
                        .header("Authorization", "Bearer " + adminToken))
                .andExpect(status().isOk());

        String contributorToken = login(applicantEmail);

        fakeVerifyClient.setGatesPassed(true);
        fakeVerifyClient.setStars(3);
        String attemptId = startAttempt(contributorToken, "freeze-check-scenario", AttemptMode.TIMED);
        mockMvc.perform(post("/attempts/" + attemptId + "/submit")
                        .header("Authorization", "Bearer " + contributorToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("graph", Map.of("nodes", List.of())))))
                .andExpect(status().isOk());

        // The attempt itself still completes normally (Workshop behaves
        // the same for them) — it just never becomes real progress/points.
        mockMvc.perform(get("/progress/scenarios/freeze-check-scenario").header("Authorization", "Bearer " + contributorToken))
                .andExpect(status().isNotFound());
        org.assertj.core.api.Assertions.assertThat(
                        pointsLedgerRepository.findByUserIdOrderByCreatedAtDesc(
                                userRepository.findByEmail(applicantEmail).orElseThrow().getId()))
                .isEmpty();
    }

    @Test
    void onlyAdminCanSeeOrReviewTheQueue() throws Exception {
        String applicantToken = registerAs("applicant2@example.com", Role.USER);
        apply(applicantToken);

        mockMvc.perform(get("/contributor-applications/top").header("Authorization", "Bearer " + applicantToken))
                .andExpect(status().isForbidden());
        mockMvc.perform(get("/contributor-applications/top")).andExpect(status().isUnauthorized());
    }

    @Test
    void topQueueOrdersByPriorityAndCapsAtFive() throws Exception {
        String adminToken = registerAs("admin3@example.com", Role.ADMIN);
        publishScenario("priority-scenario");

        // A strong applicant: one genuine solve (real points) before applying.
        String strongEmail = "strong-applicant@example.com";
        String strongToken = registerAs(strongEmail, Role.USER);
        fakeVerifyClient.setGatesPassed(true);
        fakeVerifyClient.setStars(3);
        String attemptId = startAttempt(strongToken, "priority-scenario", AttemptMode.TIMED);
        mockMvc.perform(post("/attempts/" + attemptId + "/submit")
                        .header("Authorization", "Bearer " + strongToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("graph", Map.of("nodes", List.of())))))
                .andExpect(status().isOk());
        String strongApplicationId = apply(strongToken);

        // Five weak applicants with zero stats, so six are pending total.
        for (int i = 0; i < 5; i++) {
            apply(registerAs("weak-applicant-" + i + "@example.com", Role.USER));
        }

        mockMvc.perform(get("/contributor-applications/top").header("Authorization", "Bearer " + adminToken))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$", org.hamcrest.Matchers.hasSize(5)))
                .andExpect(jsonPath("$[0].application.id").value(strongApplicationId))
                .andExpect(jsonPath("$[0].priorityScore").value(org.hamcrest.Matchers.greaterThan(0)));
    }

    private String apply(String token) throws Exception {
        String body = mockMvc.perform(post("/contributor-applications").header("Authorization", "Bearer " + token))
                .andExpect(status().isCreated())
                .andReturn().getResponse().getContentAsString();
        return objectMapper.readTree(body).get("id").asText();
    }

    private String startAttempt(String token, String scenarioId, AttemptMode mode) throws Exception {
        String body = mockMvc.perform(post("/attempts")
                        .header("Authorization", "Bearer " + token)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("scenarioId", scenarioId, "mode", mode.name()))))
                .andExpect(status().isCreated())
                .andReturn().getResponse().getContentAsString();
        return objectMapper.readTree(body).get("id").asText();
    }

    private String registerAs(String email, Role role) throws Exception {
        User user = User.builder()
                .email(email)
                .passwordHash(passwordEncoder.encode("supersecret1"))
                .displayName(email)
                .role(role)
                .build();
        userRepository.save(user);
        return login(email);
    }

    private String login(String email) throws Exception {
        String body = mockMvc.perform(post("/auth/login")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(new LoginRequest(email, "supersecret1"))))
                .andExpect(status().isOk())
                .andReturn().getResponse().getContentAsString();
        return objectMapper.readTree(body).get("accessToken").asText();
    }

    private void publishScenario(String id) {
        scenarioRepository.save(Scenario.builder()
                .id(id)
                .version(1)
                .status(ScenarioStatus.PUBLISHED)
                .title("Test Scenario " + id)
                .difficulty((short) 3)
                .topics(JsonUtil.toJson(List.of("caching")))
                .story("A test scenario.")
                .startingEntities(JsonUtil.toJson(List.of()))
                .startingConnections(JsonUtil.toJson(List.of()))
                .trafficPattern(JsonUtil.toJson(Map.of("type", "constant", "rate", 10)))
                .durationMs(1000)
                .seed(1)
                .constraints(JsonUtil.toJson(List.of()))
                .hints(JsonUtil.toJson(List.of()))
                .learningGoals(JsonUtil.toJson(List.of()))
                .build());
    }
}
