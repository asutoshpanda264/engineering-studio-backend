package com.engineeringstudio.api.support;

import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;

/**
 * `@Import` this into any integration test needing a controllable clock
 * and/or a controllable verify result — extracted once a second test class
 * (Phase 5's progress/points tests) needed the exact same pair of
 * overrides `AttemptFlowIntegrationTest` had originally declared inline,
 * to avoid two copies drifting apart. Registering the bean under its
 * concrete `FakeVerifyClient` type (not the `VerifyClient` interface) is
 * enough to satisfy BOTH `@Autowired VerifyClient` injection points
 * (application code) and `@Autowired FakeVerifyClient` ones (test code
 * that needs the setters) from the same single instance — no separate
 * alias bean needed.
 */
@TestConfiguration
public class TestServiceOverridesConfig {

    @Bean
    @Primary
    public MutableClock testClock() {
        return MutableClock.startingNow();
    }

    @Bean
    @Primary
    public FakeVerifyClient testVerifyClient() {
        return new FakeVerifyClient();
    }
}
