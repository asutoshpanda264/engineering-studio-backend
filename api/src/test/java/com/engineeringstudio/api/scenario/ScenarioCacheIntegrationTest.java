package com.engineeringstudio.api.scenario;

import static org.assertj.core.api.Assertions.assertThat;
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
import org.springframework.cache.Cache;
import org.springframework.cache.CacheManager;
import org.springframework.cache.interceptor.SimpleKey;
import org.springframework.http.MediaType;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.test.web.servlet.MockMvc;

/**
 * Proves the actual mechanics of Phase 8's scenario caching, not just that
 * a read succeeds: that a GET genuinely populates
 * {@code ScenarioService.PUBLISHED_SCENARIO_CACHE}/{@code PUBLISHED_LIST_CACHE}
 * in Redis (checked directly via {@code CacheManager}, not inferred), and
 * that publish/archive/update genuinely evict them — verified by the fact
 * a stale cached response would otherwise mask the state change entirely
 * (e.g. an archived scenario would still 200 with its old PUBLISHED body
 * if eviction hadn't actually run).
 */
class ScenarioCacheIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private PasswordEncoder passwordEncoder;

    @Autowired
    private CacheManager cacheManager;

    private final ObjectMapper objectMapper = new ObjectMapper();

    @Test
    void gettingAPublishedScenarioPopulatesTheCache() throws Exception {
        String adminToken = registerAs("cache-admin1@example.com", Role.ADMIN);
        String id = "cache-populate-scenario";
        createAndPublish(adminToken, id, "Cache Populate");

        assertThat(scenarioCache().get(id)).isNull();
        mockMvc.perform(get("/scenarios/" + id)).andExpect(status().isOk());
        assertThat(scenarioCache().get(id)).isNotNull();
    }

    @Test
    void archivingEvictsTheCachedScenario() throws Exception {
        String adminToken = registerAs("cache-admin2@example.com", Role.ADMIN);
        String id = "cache-archive-scenario";
        createAndPublish(adminToken, id, "Cache Archive");

        // Populate the cache with the PUBLISHED response.
        mockMvc.perform(get("/scenarios/" + id))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("PUBLISHED"));
        assertThat(scenarioCache().get(id)).isNotNull();

        mockMvc.perform(post("/scenarios/" + id + "/archive").header("Authorization", "Bearer " + adminToken))
                .andExpect(status().isOk());

        // If eviction hadn't run, this would still 200 with the stale
        // PUBLISHED body instead of correctly 404ing (archived scenarios
        // aren't public).
        mockMvc.perform(get("/scenarios/" + id)).andExpect(status().isNotFound());
        assertThat(scenarioCache().get(id)).isNull();
    }

    @Test
    void updatingAPublishedScenarioEvictsTheStaleTitle() throws Exception {
        String adminToken = registerAs("cache-admin3@example.com", Role.ADMIN);
        String id = "cache-update-scenario";
        createAndPublish(adminToken, id, "Original Title");

        mockMvc.perform(get("/scenarios/" + id))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.title").value("Original Title"));

        mockMvc.perform(put("/scenarios/" + id)
                        .header("Authorization", "Bearer " + adminToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(minimalRequest(id, "Updated Title"))))
                .andExpect(status().isOk());

        // Without eviction, this would still return the cached "Original
        // Title" body from before the update.
        mockMvc.perform(get("/scenarios/" + id))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.title").value("Updated Title"));
    }

    @Test
    void publishingANewScenarioEvictsTheCachedPublishedList() throws Exception {
        String adminToken = registerAs("cache-admin4@example.com", Role.ADMIN);

        mockMvc.perform(get("/scenarios")).andExpect(status().isOk());
        // A zero-arg @Cacheable method's key, per Spring's own
        // SimpleKeyGenerator (the default when no `key=` SpEL is given) —
        // the actual, documented key object, not a guessed string form of it.
        assertThat(listCache().get(SimpleKey.EMPTY)).isNotNull();

        String id = "cache-list-scenario";
        createAndPublish(adminToken, id, "Cache List");

        // Without eviction, this would still return the list from before
        // this scenario was published.
        mockMvc.perform(get("/scenarios"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[?(@.id == '" + id + "')]").exists());
    }

    private Cache scenarioCache() {
        Cache cache = cacheManager.getCache(ScenarioService.PUBLISHED_SCENARIO_CACHE);
        assertThat(cache).as("PUBLISHED_SCENARIO_CACHE must be registered").isNotNull();
        return cache;
    }

    private Cache listCache() {
        Cache cache = cacheManager.getCache(ScenarioService.PUBLISHED_LIST_CACHE);
        assertThat(cache).as("PUBLISHED_LIST_CACHE must be registered").isNotNull();
        return cache;
    }

    private void createAndPublish(String adminToken, String id, String title) throws Exception {
        mockMvc.perform(post("/scenarios")
                        .header("Authorization", "Bearer " + adminToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(minimalRequest(id, title))))
                .andExpect(status().isCreated());
        mockMvc.perform(post("/scenarios/" + id + "/publish").header("Authorization", "Bearer " + adminToken))
                .andExpect(status().isOk());
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
