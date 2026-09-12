package com.engineeringstudio.api.leaderboard;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.engineeringstudio.api.attempt.AttemptMode;
import com.engineeringstudio.api.attempt.AttemptRepository;
import com.engineeringstudio.api.auth.Role;
import com.engineeringstudio.api.auth.User;
import com.engineeringstudio.api.auth.UserRepository;
import com.engineeringstudio.api.auth.dto.LoginRequest;
import com.engineeringstudio.api.common.json.JsonUtil;
import com.engineeringstudio.api.points.PointsCalculator;
import com.engineeringstudio.api.points.PointsLedgerRepository;
import com.engineeringstudio.api.progress.ProblemProgressRepository;
import com.engineeringstudio.api.scenario.Scenario;
import com.engineeringstudio.api.scenario.ScenarioRepository;
import com.engineeringstudio.api.scenario.ScenarioStatus;
import com.engineeringstudio.api.support.AbstractIntegrationTest;
import com.engineeringstudio.api.support.FakeVerifyClient;
import com.engineeringstudio.api.support.MutableClock;
import com.engineeringstudio.api.support.TestServiceOverridesConfig;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Import;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.http.MediaType;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/**
 * Proves the real, committed path: submit → AttemptFinalizer.finalizeVerified
 * commits → ProblemProgressUpgradedEvent → LeaderboardService's
 * @TransactionalEventListener(AFTER_COMMIT) fires → Redis actually holds
 * the new membership, all before the submit HTTP call returns.
 *
 * <p>Deliberately overrides {@code @Transactional} to
 * {@link Propagation#NOT_SUPPORTED}, the same exception
 * ProblemProgressConcurrencyTest already takes and documents — but for a
 * DIFFERENT reason here: an AFTER_COMMIT listener only ever fires once its
 * transaction genuinely commits, and AbstractIntegrationTest's default
 * per-test-method wrapping transaction never commits (it rolls back at
 * the end, for isolation) — so under the default, every assertion below
 * would silently see stale/empty Redis state, not because the feature is
 * broken but because the test harness itself never let AFTER_COMMIT fire.
 * Every row (and every Redis member) this test writes is deleted
 * explicitly in {@link #cleanUp()}.
 */
@Import(TestServiceOverridesConfig.class)
@Transactional(propagation = Propagation.NOT_SUPPORTED)
class LeaderboardIntegrationTest extends AbstractIntegrationTest {

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
    private AttemptRepository attemptRepository;

    @Autowired
    private ProblemProgressRepository problemProgressRepository;

    @Autowired
    private PointsLedgerRepository pointsLedgerRepository;

    @Autowired
    private StringRedisTemplate redisTemplate;

    private final ObjectMapper objectMapper = new ObjectMapper();
    private final List<UUID> createdUserIds = new ArrayList<>();
    private final List<String> createdScenarioIds = new ArrayList<>();

    @AfterEach
    void cleanUp() {
        // No transactional rollback here (see class Javadoc) — every row
        // and every Redis ZSET member this test created is deleted
        // explicitly, children before parents.
        for (UUID userId : createdUserIds) {
            String member = userId.toString();
            for (LeaderboardType type : LeaderboardType.values()) {
                redisTemplate.opsForZSet().remove(type.redisKey(), member);
            }
            pointsLedgerRepository.findByUserIdOrderByCreatedAtDesc(userId).forEach(pointsLedgerRepository::delete);
            problemProgressRepository.findByUserId(userId).forEach(problemProgressRepository::delete);
            attemptRepository.findByUserIdOrderByCreatedAtDesc(userId).forEach(attemptRepository::delete);
            userRepository.deleteById(userId);
        }
        createdScenarioIds.forEach(scenarioRepository::deleteById);
    }

    @Test
    void timedSolvePlacesSolverOnAllThreeLeaderboardsWithScoresMatchingTheFormula() throws Exception {
        publishScenario("lb-single-solve-scenario", (short) 3);
        String token = registerAs("racer@example.com", Role.USER);
        UUID userId = userRepository.findByEmail("racer@example.com").orElseThrow().getId();

        String attemptId = startAttempt(token, "lb-single-solve-scenario", AttemptMode.TIMED);
        clock.advance(Duration.ofSeconds(300));
        fakeVerifyClient.setGatesPassed(true);
        fakeVerifyClient.setStars(3);
        // Not necessarily exactly 300: startedAt/submittedAt round-trip
        // through a real Postgres timestamp column between the two clock
        // reads, which can shave off a sub-second sliver — computing
        // expectations from the ACTUAL persisted elapsed time (not the
        // nominal clock-advance amount) is what makes fastest-solved's
        // raw, unrounded speedFactor assertion below meaningful rather
        // than flaky.
        int actualElapsedSeconds = submit(token, attemptId);

        int timeLimit = PointsCalculator.defaultTimeLimitSeconds(3);
        int expectedPoints = PointsCalculator.totalPoints(3, 3, actualElapsedSeconds, timeLimit);
        double expectedSpeedFactor = PointsCalculator.speedFactor(3, actualElapsedSeconds, timeLimit);

        assertTopEntry("most-solved", userId, 1.0);
        assertTopEntry("best-solved", userId, expectedPoints);
        assertTopEntryWithin("fastest-solved", userId, expectedSpeedFactor);

        mockMvc.perform(get("/leaderboards/most-solved/me").header("Authorization", "Bearer " + token))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.ranked").value(true))
                .andExpect(jsonPath("$.rank").value(1));
    }

    @Test
    void noPressureSolveNeverAppearsOnAnyLeaderboard() throws Exception {
        publishScenario("lb-no-pressure-scenario", (short) 2);
        String token = registerAs("practice-lb@example.com", Role.USER);

        String attemptId = startAttempt(token, "lb-no-pressure-scenario", AttemptMode.NO_PRESSURE);
        fakeVerifyClient.setGatesPassed(true);
        fakeVerifyClient.setStars(3);
        submit(token, attemptId);

        for (String type : List.of("most-solved", "best-solved", "fastest-solved")) {
            mockMvc.perform(get("/leaderboards/" + type + "/me").header("Authorization", "Bearer " + token))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.ranked").value(false));
        }
    }

    @Test
    void aFasterSolveOutranksASlowerOneOnBestAndFastestButTheyTieOnMostSolved() throws Exception {
        publishScenario("lb-ranking-scenario", (short) 5);
        String fastToken = registerAs("fast-solver@example.com", Role.USER);
        String slowToken = registerAs("slow-solver@example.com", Role.USER);
        UUID fastUserId = userRepository.findByEmail("fast-solver@example.com").orElseThrow().getId();
        UUID slowUserId = userRepository.findByEmail("slow-solver@example.com").orElseThrow().getId();

        int timeLimit = PointsCalculator.defaultTimeLimitSeconds(5);

        String fastAttempt = startAttempt(fastToken, "lb-ranking-scenario", AttemptMode.TIMED);
        clock.advance(Duration.ofSeconds(60)); // well under the limit -> high speed factor
        fakeVerifyClient.setGatesPassed(true);
        fakeVerifyClient.setStars(3);
        submit(fastToken, fastAttempt);

        String slowAttempt = startAttempt(slowToken, "lb-ranking-scenario", AttemptMode.TIMED);
        clock.advance(Duration.ofSeconds(timeLimit - 30)); // right up against the limit -> low speed factor
        submit(slowToken, slowAttempt);

        List<Map<String, Object>> bestSolved = topEntries("best-solved");
        assertThat(bestSolved.get(0).get("userId")).isEqualTo(fastUserId.toString());
        assertThat(bestSolved.get(1).get("userId")).isEqualTo(slowUserId.toString());

        List<Map<String, Object>> fastestSolved = topEntries("fastest-solved");
        assertThat(fastestSolved.get(0).get("userId")).isEqualTo(fastUserId.toString());
        assertThat(fastestSolved.get(1).get("userId")).isEqualTo(slowUserId.toString());

        List<Map<String, Object>> mostSolved = topEntries("most-solved");
        assertThat(mostSolved).extracting(entry -> ((Number) entry.get("score")).doubleValue())
                .containsOnly(1.0);
        assertThat(mostSolved).extracting(entry -> entry.get("userId"))
                .containsExactlyInAnyOrder(fastUserId.toString(), slowUserId.toString());
    }

    @Test
    void rebuildAllRepopulatesRedisFromPostgresAfterItsWiped() throws Exception {
        publishScenario("lb-rebuild-scenario", (short) 3);
        String token = registerAs("rebuild-target@example.com", Role.USER);
        UUID userId = userRepository.findByEmail("rebuild-target@example.com").orElseThrow().getId();

        String attemptId = startAttempt(token, "lb-rebuild-scenario", AttemptMode.TIMED);
        clock.advance(Duration.ofSeconds(200));
        fakeVerifyClient.setGatesPassed(true);
        fakeVerifyClient.setStars(3);
        submit(token, attemptId);

        // Confirm it's really there before wiping.
        mockMvc.perform(get("/leaderboards/most-solved/me").header("Authorization", "Bearer " + token))
                .andExpect(jsonPath("$.ranked").value(true));

        for (LeaderboardType type : LeaderboardType.values()) {
            redisTemplate.delete(type.redisKey());
        }
        mockMvc.perform(get("/leaderboards/most-solved/me").header("Authorization", "Bearer " + token))
                .andExpect(jsonPath("$.ranked").value(false));

        String adminToken = registerAs("rebuild-admin@example.com", Role.ADMIN);
        mockMvc.perform(post("/admin/leaderboard/rebuild").header("Authorization", "Bearer " + adminToken))
                .andExpect(status().isOk());

        mockMvc.perform(get("/leaderboards/most-solved/me").header("Authorization", "Bearer " + token))
                .andExpect(jsonPath("$.ranked").value(true))
                .andExpect(jsonPath("$.rank").value(1));
    }

    @Test
    void unknownLeaderboardTypeReturns400() throws Exception {
        mockMvc.perform(get("/leaderboards/nonsense")).andExpect(status().isBadRequest());
    }

    @Test
    void meEndpointRequiresAuthentication() throws Exception {
        mockMvc.perform(get("/leaderboards/most-solved/me")).andExpect(status().isUnauthorized());
    }

    private void assertTopEntry(String type, UUID userId, double expectedScore) throws Exception {
        List<Map<String, Object>> entries = topEntries(type);
        assertThat(entries).anySatisfy(entry -> {
            assertThat(entry.get("userId")).isEqualTo(userId.toString());
            assertThat(((Number) entry.get("score")).doubleValue()).isEqualTo(expectedScore);
        });
    }

    private void assertTopEntryWithin(String type, UUID userId, double expectedScore) throws Exception {
        List<Map<String, Object>> entries = topEntries(type);
        assertThat(entries).anySatisfy(entry -> {
            assertThat(entry.get("userId")).isEqualTo(userId.toString());
            assertThat(((Number) entry.get("score")).doubleValue()).isCloseTo(expectedScore, within(0.0001));
        });
    }

    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> topEntries(String type) throws Exception {
        String body = mockMvc.perform(get("/leaderboards/" + type))
                .andExpect(status().isOk())
                .andReturn().getResponse().getContentAsString();
        return objectMapper.readValue(body, List.class);
    }

    /** @return the attempt's actual persisted elapsedSeconds — see the header comment where this matters. */
    private int submit(String token, String attemptId) throws Exception {
        String body = mockMvc.perform(post("/attempts/" + attemptId + "/submit")
                        .header("Authorization", "Bearer " + token)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("graph", Map.of("nodes", List.of())))))
                .andExpect(status().isOk())
                .andReturn().getResponse().getContentAsString();
        return objectMapper.readTree(body).get("elapsedSeconds").asInt();
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
        createdUserIds.add(user.getId());

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
        createdScenarioIds.add(id);
    }
}
