package com.engineeringstudio.api.common.ratelimit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
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
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.RequestPostProcessor;

/**
 * Deliberately overrides `app.rate-limit.*` down to 3/minute (the
 * production default, 10-20/minute, would need dozens of real requests to
 * actually trip in a test) — this different property set means this class
 * gets its own Spring context, same cost every other test class here that
 * needs non-default behavior already pays (LeaderboardIntegrationTest,
 * ProblemProgressConcurrencyTest, ...). See
 * `src/test/resources/application-test.yml` for why every OTHER test
 * class instead runs with the limit turned effectively off.
 */
@Import(TestServiceOverridesConfig.class)
@TestPropertySource(properties = {
        "app.rate-limit.auth-requests-per-minute=3",
        "app.rate-limit.submit-requests-per-minute=3"
})
class RateLimitIntegrationTest extends AbstractIntegrationTest {

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

    private final ObjectMapper objectMapper = new ObjectMapper();

    @BeforeEach
    void resetFakeVerifyClient() {
        fakeVerifyClient.reset();
    }

    @Test
    void loginIsRateLimitedPerIpAfterTheConfiguredLimit() throws Exception {
        registerUser("ratelimit-login@example.com");
        RequestPostProcessor fromIp = remoteAddr("10.10.10.1");

        for (int i = 0; i < 3; i++) {
            login("ratelimit-login@example.com", fromIp).andExpect(status().isOk());
        }
        login("ratelimit-login@example.com", fromIp)
                .andExpect(status().isTooManyRequests())
                .andExpect(result -> assertThat(result.getResponse().getHeader("Retry-After")).isNotNull());
    }

    @Test
    void loginRateLimitIsPerIpNotGlobal() throws Exception {
        registerUser("ratelimit-perip@example.com");
        RequestPostProcessor ipA = remoteAddr("10.10.10.2");
        RequestPostProcessor ipB = remoteAddr("10.10.10.3");

        for (int i = 0; i < 3; i++) {
            login("ratelimit-perip@example.com", ipA).andExpect(status().isOk());
        }
        login("ratelimit-perip@example.com", ipA).andExpect(status().isTooManyRequests());
        // A different IP's own budget is untouched by A's.
        login("ratelimit-perip@example.com", ipB).andExpect(status().isOk());
    }

    @Test
    void submitIsRateLimitedPerUserAfterTheConfiguredLimit() throws Exception {
        publishScenario("ratelimit-submit-scenario");
        String token = registerAndLogin("ratelimit-submit@example.com");

        for (int i = 0; i < 3; i++) {
            String attemptId = startAttempt(token, "ratelimit-submit-scenario");
            submit(token, attemptId).andExpect(status().isOk());
        }
        String overLimitAttemptId = startAttempt(token, "ratelimit-submit-scenario");
        submit(token, overLimitAttemptId).andExpect(status().isTooManyRequests());
    }

    @Test
    void submitRateLimitIsPerUserNotGlobal() throws Exception {
        publishScenario("ratelimit-submit-peruser-scenario");
        String tokenA = registerAndLogin("ratelimit-submit-a@example.com");
        String tokenB = registerAndLogin("ratelimit-submit-b@example.com");

        for (int i = 0; i < 3; i++) {
            String attemptId = startAttempt(tokenA, "ratelimit-submit-peruser-scenario");
            submit(tokenA, attemptId).andExpect(status().isOk());
        }
        String overLimitAttemptId = startAttempt(tokenA, "ratelimit-submit-peruser-scenario");
        submit(tokenA, overLimitAttemptId).andExpect(status().isTooManyRequests());

        // User B's own budget is untouched by A's.
        String attemptForB = startAttempt(tokenB, "ratelimit-submit-peruser-scenario");
        submit(tokenB, attemptForB).andExpect(status().isOk());
    }

    private static RequestPostProcessor remoteAddr(String ip) {
        return request -> {
            request.setRemoteAddr(ip);
            return request;
        };
    }

    private org.springframework.test.web.servlet.ResultActions login(String email, RequestPostProcessor ip) throws Exception {
        return mockMvc.perform(post("/auth/login")
                .with(ip)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(new LoginRequest(email, "supersecret1"))));
    }

    private org.springframework.test.web.servlet.ResultActions submit(String token, String attemptId) throws Exception {
        return mockMvc.perform(post("/attempts/" + attemptId + "/submit")
                .header("Authorization", "Bearer " + token)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(Map.of("graph", Map.of("nodes", List.of())))));
    }

    private String startAttempt(String token, String scenarioId) throws Exception {
        String body = mockMvc.perform(post("/attempts")
                        .header("Authorization", "Bearer " + token)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(
                                Map.of("scenarioId", scenarioId, "mode", AttemptMode.TIMED.name()))))
                .andExpect(status().isCreated())
                .andReturn().getResponse().getContentAsString();
        return objectMapper.readTree(body).get("id").asText();
    }

    private void registerUser(String email) {
        userRepository.save(User.builder()
                .email(email)
                .passwordHash(passwordEncoder.encode("supersecret1"))
                .displayName(email)
                .role(Role.USER)
                .build());
    }

    /** A dedicated, never-asserted-against IP for setup logins — keeps this method's own call count (at most 2 across this whole class) from ever sharing a budget with the login-specific tests above, which each exercise their own fixed IPs up to the 3/minute limit. */
    private static final RequestPostProcessor SETUP_LOGIN_IP = remoteAddr("10.10.10.200");

    private String registerAndLogin(String email) throws Exception {
        registerUser(email);
        String body = mockMvc.perform(post("/auth/login")
                        .with(SETUP_LOGIN_IP)
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
                .title("Rate Limit Test Scenario " + id)
                .difficulty((short) 2)
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
