package com.engineeringstudio.api.dailychallenge;

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
import com.engineeringstudio.api.scenario.Scenario;
import com.engineeringstudio.api.scenario.ScenarioRepository;
import com.engineeringstudio.api.scenario.ScenarioStatus;
import com.engineeringstudio.api.support.AbstractIntegrationTest;
import com.engineeringstudio.api.support.FakeVerifyClient;
import com.engineeringstudio.api.support.MutableClock;
import com.engineeringstudio.api.support.TestServiceOverridesConfig;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Duration;
import java.time.LocalDate;
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
 * Extends AbstractIntegrationTest as-is — deliberately NOT the
 * {@code @Transactional(propagation = NOT_SUPPORTED)} override
 * LeaderboardIntegrationTest (Phase 6) needed. That override existed
 * ONLY because Redis sits outside the JPA transaction and needs a real
 * commit to observe via {@code @TransactionalEventListener(AFTER_COMMIT)}.
 * DailyChallengeService listens with a plain {@code @EventListener}
 * instead (see its own class Javadoc) — every write it makes is ordinary
 * Postgres, fully covered by AbstractIntegrationTest's default
 * per-test-method rollback, exactly like ProblemProgressIntegrationTest.
 * No {@code @AfterEach} cleanup needed here for the same reason.
 */
@Import(TestServiceOverridesConfig.class)
class DailyChallengeIntegrationTest extends AbstractIntegrationTest {

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

    @BeforeEach
    void resetFakeVerifyClient() {
        fakeVerifyClient.reset();
    }

    @Test
    void todayAutoAssignsAndIsStableAcrossRepeatedCalls() throws Exception {
        String first = todayScenarioId();
        String second = todayScenarioId();
        assertThat(second).isEqualTo(first);
    }

    @Test
    void aFutureDateReturns404() throws Exception {
        LocalDate future = LocalDate.now(clock).plusDays(5);
        mockMvc.perform(get("/daily-challenge/" + future)).andExpect(status().isNotFound());
    }

    @Test
    void aMalformedDateReturns400() throws Exception {
        mockMvc.perform(get("/daily-challenge/not-a-date")).andExpect(status().isBadRequest());
    }

    @Test
    void timedSolveOfTodaysChallengeIncrementsStreakAndRecordsCompletion() throws Exception {
        publishScenario("dc-timed-scenario", (short) 2);
        String adminToken = registerAs("dc-admin1@example.com", Role.ADMIN);
        assignToday(adminToken, "dc-timed-scenario");

        String token = registerAs("dc-timed-solver@example.com", Role.USER);
        String attemptId = startAttempt(token, "dc-timed-scenario", AttemptMode.TIMED);
        fakeVerifyClient.setGatesPassed(true);
        submit(token, attemptId);

        mockMvc.perform(get("/daily-challenge/today/me").header("Authorization", "Bearer " + token))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.completedToday").value(true));

        mockMvc.perform(get("/me").header("Authorization", "Bearer " + token))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.currentStreak").value(1))
                .andExpect(jsonPath("$.longestStreak").value(1));

        mockMvc.perform(get("/daily-challenge/history").header("Authorization", "Bearer " + token))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.length()").value(1))
                .andExpect(jsonPath("$[0].scenarioId").value("dc-timed-scenario"))
                .andExpect(jsonPath("$[0].mode").value("TIMED"));
    }

    @Test
    void noPressureSolveOfTodaysChallengeStillMaintainsTheStreak() throws Exception {
        publishScenario("dc-practice-scenario", (short) 2);
        String adminToken = registerAs("dc-admin2@example.com", Role.ADMIN);
        assignToday(adminToken, "dc-practice-scenario");

        String token = registerAs("dc-practice-solver@example.com", Role.USER);
        String attemptId = startAttempt(token, "dc-practice-scenario", AttemptMode.NO_PRESSURE);
        fakeVerifyClient.setGatesPassed(true);
        submit(token, attemptId);

        mockMvc.perform(get("/me").header("Authorization", "Bearer " + token))
                .andExpect(jsonPath("$.currentStreak").value(1));
    }

    @Test
    void solvingAScenarioThatIsNotTodaysChallengeDoesNotTouchTheStreak() throws Exception {
        publishScenario("dc-today-scenario", (short) 2);
        publishScenario("dc-other-scenario", (short) 2);
        String adminToken = registerAs("dc-admin3@example.com", Role.ADMIN);
        assignToday(adminToken, "dc-today-scenario");

        String token = registerAs("dc-off-target-solver@example.com", Role.USER);
        String attemptId = startAttempt(token, "dc-other-scenario", AttemptMode.TIMED);
        fakeVerifyClient.setGatesPassed(true);
        submit(token, attemptId);

        mockMvc.perform(get("/me").header("Authorization", "Bearer " + token))
                .andExpect(jsonPath("$.currentStreak").value(0));
        mockMvc.perform(get("/daily-challenge/today/me").header("Authorization", "Bearer " + token))
                .andExpect(jsonPath("$.completedToday").value(false));
    }

    @Test
    void aSecondSolveOfTodaysChallengeSameDayDoesNotDoubleIncrementTheStreak() throws Exception {
        publishScenario("dc-repeat-scenario", (short) 2);
        String adminToken = registerAs("dc-admin4@example.com", Role.ADMIN);
        assignToday(adminToken, "dc-repeat-scenario");

        String token = registerAs("dc-repeat-solver@example.com", Role.USER);

        String firstAttempt = startAttempt(token, "dc-repeat-scenario", AttemptMode.TIMED);
        fakeVerifyClient.setGatesPassed(true);
        submit(token, firstAttempt);

        String secondAttempt = startAttempt(token, "dc-repeat-scenario", AttemptMode.TIMED);
        submit(token, secondAttempt);

        mockMvc.perform(get("/me").header("Authorization", "Bearer " + token))
                .andExpect(jsonPath("$.currentStreak").value(1));
        mockMvc.perform(get("/daily-challenge/history").header("Authorization", "Bearer " + token))
                .andExpect(jsonPath("$.length()").value(1));
    }

    @Test
    void streakContinuesOnConsecutiveDaysAndResetsAfterAGap() throws Exception {
        publishScenario("dc-day1-scenario", (short) 2);
        publishScenario("dc-day2-scenario", (short) 2);
        publishScenario("dc-day5-scenario", (short) 2);
        String adminToken = registerAs("dc-admin5@example.com", Role.ADMIN);
        String token = registerAs("dc-streak-solver@example.com", Role.USER);

        assignToday(adminToken, "dc-day1-scenario");
        String day1Attempt = startAttempt(token, "dc-day1-scenario", AttemptMode.TIMED);
        fakeVerifyClient.setGatesPassed(true);
        submit(token, day1Attempt);

        clock.advance(Duration.ofDays(1));
        assignToday(adminToken, "dc-day2-scenario");
        String day2Attempt = startAttempt(token, "dc-day2-scenario", AttemptMode.TIMED);
        submit(token, day2Attempt);

        mockMvc.perform(get("/me").header("Authorization", "Bearer " + token))
                .andExpect(jsonPath("$.currentStreak").value(2))
                .andExpect(jsonPath("$.longestStreak").value(2));

        clock.advance(Duration.ofDays(3)); // a gap -> day2 -> day5, not consecutive
        assignToday(adminToken, "dc-day5-scenario");
        String day5Attempt = startAttempt(token, "dc-day5-scenario", AttemptMode.TIMED);
        submit(token, day5Attempt);

        mockMvc.perform(get("/me").header("Authorization", "Bearer " + token))
                .andExpect(jsonPath("$.currentStreak").value(1))
                .andExpect(jsonPath("$.longestStreak").value(2));
    }

    @Test
    void adminCanOverrideAnAlreadyAutoAssignedDate() throws Exception {
        publishScenario("dc-override-scenario", (short) 2);
        String todayFirst = todayScenarioId(); // triggers AUTO assignment for today

        String adminToken = registerAs("dc-admin6@example.com", Role.ADMIN);
        assignToday(adminToken, "dc-override-scenario");

        String todayAfterOverride = todayScenarioId();
        assertThat(todayAfterOverride).isEqualTo("dc-override-scenario");
        // Not asserting todayFirst != todayAfterOverride: the AUTO pick
        // could coincidentally have already been this exact scenario.
    }

    @Test
    void nonAdminCannotAssignADailyChallenge() throws Exception {
        publishScenario("dc-forbidden-scenario", (short) 2);
        String userToken = registerAs("dc-not-admin@example.com", Role.USER);

        mockMvc.perform(post("/admin/daily-challenge/" + LocalDate.now(clock))
                        .header("Authorization", "Bearer " + userToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("scenarioId", "dc-forbidden-scenario"))))
                .andExpect(status().isForbidden());
    }

    private String todayScenarioId() throws Exception {
        String body = mockMvc.perform(get("/daily-challenge/today"))
                .andExpect(status().isOk())
                .andReturn().getResponse().getContentAsString();
        return objectMapper.readTree(body).get("scenarioId").asText();
    }

    private void assignToday(String adminToken, String scenarioId) throws Exception {
        mockMvc.perform(post("/admin/daily-challenge/" + LocalDate.now(clock))
                        .header("Authorization", "Bearer " + adminToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("scenarioId", scenarioId))))
                .andExpect(status().isNoContent());
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
