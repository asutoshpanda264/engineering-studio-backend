package com.engineeringstudio.api.attempt;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.engineeringstudio.api.auth.Role;
import com.engineeringstudio.api.auth.User;
import com.engineeringstudio.api.auth.UserRepository;
import com.engineeringstudio.api.auth.dto.LoginRequest;
import com.engineeringstudio.api.common.json.JsonUtil;
import com.engineeringstudio.api.scenario.Scenario;
import com.engineeringstudio.api.scenario.ScenarioRepository;
import com.engineeringstudio.api.scenario.ScenarioStatus;
import com.engineeringstudio.api.support.AbstractIntegrationTest;
import com.engineeringstudio.api.support.FakeVerifyClient;
import com.engineeringstudio.api.support.MutableClock;
import com.engineeringstudio.api.support.TestServiceOverridesConfig;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Duration;
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
 * The M3 checkpoint: full timed lifecycle (start -&gt; pause -&gt; resume -&gt;
 * submit) with elapsed time computed correctly server-side (paused time
 * excluded), NO_PRESSURE mode's timer/pause restrictions, ownership
 * boundaries, and the VERIFY_FAILED retry path — using FakeVerifyClient's
 * (Phase 3-only) forced-failure hook rather than a real network failure.
 */
@Import(TestServiceOverridesConfig.class)
class AttemptFlowIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private MutableClock clock;

    @Autowired
    private FakeVerifyClient fakeVerifyClient;

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private ScenarioRepository scenarioRepository;

    @Autowired
    private PasswordEncoder passwordEncoder;

    private final ObjectMapper objectMapper = new ObjectMapper();

    // FakeVerifyClient is a single shared bean across every test method in
    // this class (one Spring context) — reset it before each test so a
    // setter call in one method (none today, but Phase 5's sibling test
    // class relies on this same reset discipline) can never leak into
    // another.
    @BeforeEach
    void resetFakeVerifyClient() {
        fakeVerifyClient.reset();
    }

    @Test
    void fullTimedLifecycleComputesElapsedTimeExcludingPausedTime() throws Exception {
        publishScenario("timed-flow-scenario");
        String token = registerAs("timed-user@example.com", Role.USER);

        String attemptId = startAttempt(token, "timed-flow-scenario", AttemptMode.TIMED);

        clock.advance(Duration.ofSeconds(30));
        mockMvc.perform(post("/attempts/" + attemptId + "/pause").header("Authorization", "Bearer " + token))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("PAUSED"));

        // This 100s must NOT count toward elapsed time.
        clock.advance(Duration.ofSeconds(100));
        mockMvc.perform(post("/attempts/" + attemptId + "/resume").header("Authorization", "Bearer " + token))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("IN_PROGRESS"))
                .andExpect(jsonPath("$.totalPausedSeconds").value(100));

        clock.advance(Duration.ofSeconds(20));
        mockMvc.perform(post("/attempts/" + attemptId + "/submit")
                        .header("Authorization", "Bearer " + token)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("graph", Map.of("nodes", List.of())))))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("SUBMITTED"))
                .andExpect(jsonPath("$.elapsedSeconds").value(50)) // 30 + 20, not +100
                .andExpect(jsonPath("$.verifyScore.stars").value(3));
    }

    @Test
    void noPressureModeHasNoElapsedTimeAndRejectsPause() throws Exception {
        publishScenario("no-pressure-scenario");
        String token = registerAs("practice-user@example.com", Role.USER);

        String attemptId = startAttempt(token, "no-pressure-scenario", AttemptMode.NO_PRESSURE);

        mockMvc.perform(post("/attempts/" + attemptId + "/pause").header("Authorization", "Bearer " + token))
                .andExpect(status().isConflict());

        mockMvc.perform(post("/attempts/" + attemptId + "/submit")
                        .header("Authorization", "Bearer " + token)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("graph", Map.of("nodes", List.of())))))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("SUBMITTED"))
                .andExpect(jsonPath("$.elapsedSeconds").doesNotExist());
    }

    @Test
    void cannotAttemptADraftScenario() throws Exception {
        Scenario draft = minimalScenario("still-a-draft", ScenarioStatus.DRAFT);
        scenarioRepository.save(draft);
        String token = registerAs("blocked-user@example.com", Role.USER);

        mockMvc.perform(post("/attempts")
                        .header("Authorization", "Bearer " + token)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("scenarioId", "still-a-draft", "mode", "TIMED"))))
                .andExpect(status().isConflict());
    }

    @Test
    void onlyTheOwnerCanActOnTheirAttempt() throws Exception {
        publishScenario("ownership-scenario");
        String ownerToken = registerAs("owner-attempt@example.com", Role.USER);
        String otherToken = registerAs("other-attempt@example.com", Role.USER);

        String attemptId = startAttempt(ownerToken, "ownership-scenario", AttemptMode.TIMED);

        mockMvc.perform(post("/attempts/" + attemptId + "/pause").header("Authorization", "Bearer " + otherToken))
                .andExpect(status().isForbidden());
        mockMvc.perform(get("/attempts/" + attemptId).header("Authorization", "Bearer " + otherToken))
                .andExpect(status().isForbidden());
    }

    @Test
    void adminCanViewAnyonesAttempt() throws Exception {
        publishScenario("admin-view-scenario");
        String userToken = registerAs("viewed-user@example.com", Role.USER);
        String adminToken = registerAs("viewing-admin@example.com", Role.ADMIN);

        String attemptId = startAttempt(userToken, "admin-view-scenario", AttemptMode.TIMED);

        mockMvc.perform(get("/attempts/" + attemptId).header("Authorization", "Bearer " + adminToken))
                .andExpect(status().isOk());
    }

    @Test
    void cannotSubmitAnAlreadySubmittedAttempt() throws Exception {
        publishScenario("double-submit-scenario");
        String token = registerAs("double-submit@example.com", Role.USER);
        String attemptId = startAttempt(token, "double-submit-scenario", AttemptMode.NO_PRESSURE);

        String body = objectMapper.writeValueAsString(Map.of("graph", Map.of("nodes", List.of())));
        mockMvc.perform(post("/attempts/" + attemptId + "/submit")
                        .header("Authorization", "Bearer " + token)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andExpect(status().isOk());

        mockMvc.perform(post("/attempts/" + attemptId + "/submit")
                        .header("Authorization", "Bearer " + token)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andExpect(status().isConflict());
    }

    @Test
    void verifyFailureLeavesTheAttemptInAResubmittableState() throws Exception {
        publishScenario(FakeVerifyClient.FORCED_FAILURE_SCENARIO_ID);
        String token = registerAs("verify-fail-user@example.com", Role.USER);
        String attemptId = startAttempt(token, FakeVerifyClient.FORCED_FAILURE_SCENARIO_ID, AttemptMode.NO_PRESSURE);

        String body = objectMapper.writeValueAsString(Map.of("graph", Map.of("nodes", List.of())));

        mockMvc.perform(post("/attempts/" + attemptId + "/submit")
                        .header("Authorization", "Bearer " + token)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andExpect(status().isBadGateway());

        mockMvc.perform(get("/attempts/" + attemptId).header("Authorization", "Bearer " + token))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("VERIFY_FAILED"));

        // Retrying is allowed (not blocked as "already submitted") — still
        // fails because the stub always fails for this scenario id, but
        // the important thing is it's NOT a 409.
        mockMvc.perform(post("/attempts/" + attemptId + "/submit")
                        .header("Authorization", "Bearer " + token)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andExpect(status().isBadGateway());
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

        String body = mockMvc.perform(post("/auth/login")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(new LoginRequest(email, "supersecret1"))))
                .andExpect(status().isOk())
                .andReturn().getResponse().getContentAsString();
        return objectMapper.readTree(body).get("accessToken").asText();
    }

    private void publishScenario(String id) {
        scenarioRepository.save(minimalScenario(id, ScenarioStatus.PUBLISHED));
    }

    private Scenario minimalScenario(String id, ScenarioStatus status) {
        return Scenario.builder()
                .id(id)
                .version(1)
                .status(status)
                .title("Test Scenario " + id)
                .difficulty((short) 1)
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
                .build();
    }
}
