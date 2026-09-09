package com.engineeringstudio.api.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.engineeringstudio.api.auth.dto.LoginRequest;
import com.engineeringstudio.api.support.AbstractIntegrationTest;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

/**
 * The M1 checkpoint from the plan, end to end against a real Postgres
 * container: register -> login -> /me -> RBAC (403 as USER, 200 as ADMIN)
 * -> refresh-token rotation -> logout revocation.
 */
class AuthFlowIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    // A plain local instance, not @Autowired — Spring Boot 4 auto-configures
    // the newer Jackson 3.x ("tools.jackson") stack for the app's own HTTP
    // serialization, so there's no `com.fasterxml.jackson.databind.ObjectMapper`
    // bean in the context anymore (see decisions.md). This test only uses it
    // to build/parse plain JSON strings for MockMvc, which doesn't need to
    // match whatever the app uses internally.
    private final ObjectMapper objectMapper = new ObjectMapper();

    @Autowired
    private UserRepository userRepository;

    @Test
    void registerThenLoginThenMe() throws Exception {
        String email = "solver@example.com";
        register(email, "supersecret1", "Solver One");

        String accessToken = loginAndGetAccessToken(email, "supersecret1");

        mockMvc.perform(get("/me").header("Authorization", "Bearer " + accessToken))
                .andExpect(status().isOk())
                .andExpect(org.springframework.test.web.servlet.result.MockMvcResultMatchers
                        .jsonPath("$.email").value(email))
                .andExpect(org.springframework.test.web.servlet.result.MockMvcResultMatchers
                        .jsonPath("$.role").value("USER"));
    }

    @Test
    void registeringTheSameEmailTwiceConflicts() throws Exception {
        register("dup@example.com", "supersecret1", "Dup");

        mockMvc.perform(post("/auth/register")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(new RegisterBody(
                                "dup@example.com", "supersecret1", "Dup Again"))))
                .andExpect(status().isConflict());
    }

    @Test
    void userIsForbiddenFromAdminEndpointUntilPromoted() throws Exception {
        String email = "regular@example.com";
        register(email, "supersecret1", "Regular User");
        String userToken = loginAndGetAccessToken(email, "supersecret1");

        mockMvc.perform(get("/admin/ping").header("Authorization", "Bearer " + userToken))
                .andExpect(status().isForbidden());

        // Promote directly via the repository — role-management endpoints
        // don't exist yet (later milestone); this is exactly what the plan
        // called "manually promoting to ADMIN in the test DB."
        User user = userRepository.findByEmail(email).orElseThrow();
        user.setRole(Role.ADMIN);
        userRepository.save(user);

        // The OLD access token still carries the stale "USER" role claim
        // (JWTs are immutable once issued) — a fresh login is required to
        // get a token reflecting the new role. Confirms JWT claims really
        // are captured at issuance, not re-checked against the DB per
        // request.
        String adminToken = loginAndGetAccessToken(email, "supersecret1");
        mockMvc.perform(get("/admin/ping").header("Authorization", "Bearer " + adminToken))
                .andExpect(status().isOk());
    }

    @Test
    void refreshTokenRotatesAndOldTokenCannotBeReused() throws Exception {
        String email = "rotator@example.com";
        register(email, "supersecret1", "Rotator");

        String body = mockMvc.perform(post("/auth/login")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(new LoginRequest(email, "supersecret1"))))
                .andExpect(status().isOk())
                .andReturn().getResponse().getContentAsString();
        var pair = objectMapper.readTree(body);
        String originalRefreshToken = pair.get("refreshToken").asText();

        // First use succeeds and rotates.
        String secondBody = mockMvc.perform(post("/auth/refresh")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"refreshToken\":\"" + originalRefreshToken + "\"}"))
                .andExpect(status().isOk())
                .andReturn().getResponse().getContentAsString();
        String newRefreshToken = objectMapper.readTree(secondBody).get("refreshToken").asText();
        assertThat(newRefreshToken).isNotEqualTo(originalRefreshToken);

        // Reusing the now-revoked original token must fail.
        mockMvc.perform(post("/auth/refresh")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"refreshToken\":\"" + originalRefreshToken + "\"}"))
                .andExpect(status().isUnauthorized());
    }

    @Test
    void logoutRevokesTheRefreshToken() throws Exception {
        String email = "logout@example.com";
        register(email, "supersecret1", "Logout Test");

        String body = mockMvc.perform(post("/auth/login")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(new LoginRequest(email, "supersecret1"))))
                .andExpect(status().isOk())
                .andReturn().getResponse().getContentAsString();
        String refreshToken = objectMapper.readTree(body).get("refreshToken").asText();

        mockMvc.perform(post("/auth/logout")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"refreshToken\":\"" + refreshToken + "\"}"))
                .andExpect(status().isNoContent());

        mockMvc.perform(post("/auth/refresh")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"refreshToken\":\"" + refreshToken + "\"}"))
                .andExpect(status().isUnauthorized());
    }

    private void register(String email, String password, String displayName) throws Exception {
        mockMvc.perform(post("/auth/register")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(new RegisterBody(email, password, displayName))))
                .andExpect(status().isCreated());
    }

    private String loginAndGetAccessToken(String email, String password) throws Exception {
        String body = mockMvc.perform(post("/auth/login")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(new LoginRequest(email, password))))
                .andExpect(status().isOk())
                .andReturn().getResponse().getContentAsString();
        return objectMapper.readTree(body).get("accessToken").asText();
    }

    private record RegisterBody(String email, String password, String displayName) {
    }
}
