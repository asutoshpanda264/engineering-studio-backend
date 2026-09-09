package com.engineeringstudio.api.progress;

import static org.assertj.core.api.Assertions.assertThat;
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
import com.engineeringstudio.api.points.PointsCalculator;
import com.engineeringstudio.api.points.PointsLedgerRepository;
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
 * Covers the non-concurrent parts of the M5 checkpoint: solving marks
 * SOLVED and awards points matching PointsCalculator exactly; a
 * re-attempt only upgrades best_* when it's genuinely better; NO_PRESSURE
 * marks solved but awards nothing; a failed-gate submission stays
 * ATTEMPTED. The concurrency guarantee itself is
 * ProblemProgressConcurrencyTest, which needs different Spring
 * transactional isolation (see that class's own header comment).
 */
@Import(TestServiceOverridesConfig.class)
class ProblemProgressIntegrationTest extends AbstractIntegrationTest {

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

    @Autowired
    private PointsLedgerRepository pointsLedgerRepository;

    private final ObjectMapper objectMapper = new ObjectMapper();

    @BeforeEach
    void resetFakeVerifyClient() {
        fakeVerifyClient.reset();
    }

    @Test
    void solvingAScenarioMarksSolvedAndAwardsPointsMatchingTheFormula() throws Exception {
        publishScenario("progress-solve-scenario", (short) 3); // difficulty 3, no suggestedTimeLimitMinutes -> default 1200s
        String token = registerAs("solver@example.com", Role.USER);

        String attemptId = startAttempt(token, "progress-solve-scenario", AttemptMode.TIMED);
        clock.advance(Duration.ofSeconds(300)); // 300s elapsed out of a 1200s default limit

        fakeVerifyClient.setGatesPassed(true);
        fakeVerifyClient.setStars(3);
        fakeVerifyClient.setComposite(0.8);

        submit(token, attemptId);

        int expectedPoints = PointsCalculator.totalPoints(3, 3, 300, PointsCalculator.defaultTimeLimitSeconds(3));

        mockMvc.perform(get("/progress/scenarios/progress-solve-scenario").header("Authorization", "Bearer " + token))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("SOLVED"))
                .andExpect(jsonPath("$.bestStars").value(3))
                .andExpect(jsonPath("$.bestPoints").value(expectedPoints));

        List<?> ledger = pointsLedgerRepository.findByUserIdOrderByCreatedAtDesc(
                userRepository.findByEmail("solver@example.com").orElseThrow().getId());
        assertThat(ledger).hasSize(1);
    }

    @Test
    void reSolvingAtLowerQualityDoesNotDowngradeOrAwardMorePoints() throws Exception {
        publishScenario("progress-downgrade-scenario", (short) 3);
        String token = registerAs("downgrader@example.com", Role.USER);

        // First solve: 5 stars, fast.
        String firstAttempt = startAttempt(token, "progress-downgrade-scenario", AttemptMode.TIMED);
        clock.advance(Duration.ofSeconds(60));
        fakeVerifyClient.setGatesPassed(true);
        fakeVerifyClient.setStars(5);
        submit(token, firstAttempt);
        int bestAfterFirst = PointsCalculator.totalPoints(3, 5, 60, PointsCalculator.defaultTimeLimitSeconds(3));

        // Second solve: 1 star, slow — strictly worse, must not overwrite best_*.
        String secondAttempt = startAttempt(token, "progress-downgrade-scenario", AttemptMode.TIMED);
        clock.advance(Duration.ofSeconds(1200));
        fakeVerifyClient.setStars(1);
        submit(token, secondAttempt);

        mockMvc.perform(get("/progress/scenarios/progress-downgrade-scenario").header("Authorization", "Bearer " + token))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.bestStars").value(5))
                .andExpect(jsonPath("$.bestPoints").value(bestAfterFirst));

        List<?> ledger = pointsLedgerRepository.findByUserIdOrderByCreatedAtDesc(
                userRepository.findByEmail("downgrader@example.com").orElseThrow().getId());
        assertThat(ledger).hasSize(1); // only the first (improving) solve produced a ledger entry
    }

    @Test
    void noPressureModeMarksSolvedButAwardsNoPoints() throws Exception {
        publishScenario("progress-no-pressure-scenario", (short) 2);
        String token = registerAs("practice-progress@example.com", Role.USER);

        String attemptId = startAttempt(token, "progress-no-pressure-scenario", AttemptMode.NO_PRESSURE);
        fakeVerifyClient.setGatesPassed(true);
        fakeVerifyClient.setStars(3);
        submit(token, attemptId);

        mockMvc.perform(get("/progress/scenarios/progress-no-pressure-scenario").header("Authorization", "Bearer " + token))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("SOLVED"))
                .andExpect(jsonPath("$.bestPoints").value(0));

        List<?> ledger = pointsLedgerRepository.findByUserIdOrderByCreatedAtDesc(
                userRepository.findByEmail("practice-progress@example.com").orElseThrow().getId());
        assertThat(ledger).isEmpty();
    }

    @Test
    void failingTheGateStaysAttemptedWithNoPoints() throws Exception {
        publishScenario("progress-failed-gate-scenario", (short) 2);
        String token = registerAs("failing-user@example.com", Role.USER);

        String attemptId = startAttempt(token, "progress-failed-gate-scenario", AttemptMode.TIMED);
        fakeVerifyClient.setGatesPassed(false);
        submit(token, attemptId);

        mockMvc.perform(get("/progress/scenarios/progress-failed-gate-scenario").header("Authorization", "Bearer " + token))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("ATTEMPTED"))
                .andExpect(jsonPath("$.bestPoints").value(0));
    }

    @Test
    void unknownScenarioProgressReturns404() throws Exception {
        String token = registerAs("no-progress-yet@example.com", Role.USER);
        mockMvc.perform(get("/progress/scenarios/never-attempted").header("Authorization", "Bearer " + token))
                .andExpect(status().isNotFound());
    }

    private void submit(String token, String attemptId) throws Exception {
        mockMvc.perform(post("/attempts/" + attemptId + "/submit")
                        .header("Authorization", "Bearer " + token)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("graph", Map.of("nodes", List.of())))))
                .andExpect(status().isOk());
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

    private void publishScenario(String id, short difficulty) {
        scenarioRepository.save(Scenario.builder()
                .id(id)
                .version(1)
                .status(ScenarioStatus.PUBLISHED)
                .title("Test Scenario " + id)
                .difficulty(difficulty)
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
