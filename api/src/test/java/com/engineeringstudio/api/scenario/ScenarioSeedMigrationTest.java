package com.engineeringstudio.api.scenario;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.engineeringstudio.api.support.AbstractIntegrationTest;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.web.servlet.MockMvc;

/**
 * Validates the V2.1 seed migration (the 32-scenario import from the
 * frontend's src/scenarios/index.ts — see
 * masterdoc/phase-2-scenario-crud/decisions.md for the extraction/generation
 * process). Runs against the real Flyway migration, same as every other
 * integration test — this isn't testing separate "seed data," it's proving
 * the migration that ships to every environment (including production)
 * actually produces 32 valid, publicly-visible scenarios.
 */
class ScenarioSeedMigrationTest extends AbstractIntegrationTest {

    // A handful of known ids, not all 32 — enough to catch a wholesale
    // extraction failure (wrong field, empty array) without this test
    // becoming a second copy of the frontend's own scenario list.
    private static final Set<String> EXPECTED_IDS = Set.of(
            "url-shortener", "movie-ticket-booking", "internal-admin-dashboard");

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ScenarioRepository scenarioRepository;

    @Test
    void allThirtyTwoScenariosLandAsPublished() {
        List<Scenario> all = scenarioRepository.findAll();
        assertThat(all).hasSize(32);
        assertThat(all).allSatisfy(s -> {
            assertThat(s.getStatus()).isEqualTo(ScenarioStatus.PUBLISHED);
            assertThat(s.getVersion()).isEqualTo(1);
            assertThat(s.getDifficulty()).isBetween((short) 1, (short) 5);
        });
        Set<String> ids = all.stream().map(Scenario::getId).collect(java.util.stream.Collectors.toSet());
        assertThat(ids).containsAll(EXPECTED_IDS);
    }

    @Test
    void publicListingReturnsAllThirtyTwo() throws Exception {
        mockMvc.perform(get("/scenarios"))
                .andExpect(status().isOk())
                .andExpect(org.springframework.test.web.servlet.result.MockMvcResultMatchers
                        .jsonPath("$.length()").value(32));
    }

    @Test
    void aKnownScenarioRoundTripsWithoutLoss() throws Exception {
        // Deserializing the full JSONB round-trip through ScenarioMapper —
        // catches any field the mapper silently drops or mis-maps, for a
        // scenario with almost every optional field populated (an
        // optimalSolution, capacityEstimate, budget, locked fields).
        mockMvc.perform(get("/scenarios/internal-admin-dashboard"))
                .andExpect(status().isOk())
                .andExpect(org.springframework.test.web.servlet.result.MockMvcResultMatchers
                        .jsonPath("$.optimalSolution.summary").exists())
                .andExpect(org.springframework.test.web.servlet.result.MockMvcResultMatchers
                        .jsonPath("$.lockedFields.client[0]").value("requestRate"))
                .andExpect(org.springframework.test.web.servlet.result.MockMvcResultMatchers
                        .jsonPath("$.constraints.length()").value(2));
    }
}
