package com.engineeringstudio.api.bugreport;

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

/** Covers: any signed-in role can file -> only ADMIN can list/review -> review sets resolvedAt on RESOLVED, not before. */
class BugReportCrudIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private PasswordEncoder passwordEncoder;

    private final ObjectMapper objectMapper = new ObjectMapper();

    @Test
    void anySignedInRoleCanFileAndOnlyAdminCanReviewIt() throws Exception {
        String userToken = registerAs("user1@example.com", Role.USER);
        String adminToken = registerAs("admin1@example.com", Role.ADMIN);

        String body = mockMvc.perform(post("/bug-reports")
                        .header("Authorization", "Bearer " + userToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(request("The button does nothing", "/workshop"))))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.status").value("OPEN"))
                .andExpect(jsonPath("$.resolvedAt").doesNotExist())
                .andReturn().getResponse().getContentAsString();
        String id = objectMapper.readTree(body).get("id").asText();

        mockMvc.perform(get("/bug-reports").header("Authorization", "Bearer " + userToken))
                .andExpect(status().isForbidden());
        mockMvc.perform(get("/bug-reports")).andExpect(status().isUnauthorized());

        mockMvc.perform(get("/bug-reports").header("Authorization", "Bearer " + adminToken))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].id").value(id));

        Map<String, Object> moveToInProgress = new LinkedHashMap<>();
        moveToInProgress.put("status", "IN_PROGRESS");
        moveToInProgress.put("adminNote", "Looking into it");
        mockMvc.perform(post("/bug-reports/" + id + "/review")
                        .header("Authorization", "Bearer " + adminToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(moveToInProgress)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("IN_PROGRESS"))
                .andExpect(jsonPath("$.resolvedAt").doesNotExist());

        Map<String, Object> resolve = new LinkedHashMap<>();
        resolve.put("status", "RESOLVED");
        resolve.put("adminNote", "Fixed in the nav rewrite");
        mockMvc.perform(post("/bug-reports/" + id + "/review")
                        .header("Authorization", "Bearer " + adminToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(resolve)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("RESOLVED"))
                .andExpect(jsonPath("$.resolvedAt").exists());

        // A non-admin still can't review even though the report exists.
        mockMvc.perform(post("/bug-reports/" + id + "/review")
                        .header("Authorization", "Bearer " + userToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(resolve)))
                .andExpect(status().isForbidden());
    }

    @Test
    void invalidRequestBodyFailsValidation() throws Exception {
        String userToken = registerAs("user2@example.com", Role.USER);
        Map<String, Object> invalid = new LinkedHashMap<>();
        invalid.put("description", "");
        invalid.put("route", "/workshop");
        invalid.put("userAgent", "Mozilla/5.0");

        mockMvc.perform(post("/bug-reports")
                        .header("Authorization", "Bearer " + userToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(invalid)))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.fieldErrors.description").exists());
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

    private Map<String, Object> request(String description, String route) {
        Map<String, Object> request = new LinkedHashMap<>();
        request.put("description", description);
        request.put("route", route);
        request.put("userAgent", "Mozilla/5.0 (test)");
        return request;
    }
}
