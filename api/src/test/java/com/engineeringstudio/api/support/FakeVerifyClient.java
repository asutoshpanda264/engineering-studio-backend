package com.engineeringstudio.api.support;

import com.engineeringstudio.api.attempt.verify.VerifyClient;
import com.engineeringstudio.api.attempt.verify.VerifyException;
import com.engineeringstudio.api.attempt.verify.VerifyRequest;
import com.engineeringstudio.api.attempt.verify.VerifyResult;
import java.util.List;
import java.util.Map;

/**
 * A test-only, MUTABLE stand-in for the real engineering-studio-verify
 * HTTP call — see the Phase 4 doc for why Java integration tests don't
 * need a live Node process. Mutable (setters, not constructor-only)
 * specifically so a single `@Primary`-registered instance can return a
 * different canned result per test method within the same test class
 * (Phase 5's progress/points tests need to control `gatesPassed`/`stars`/
 * `composite` precisely — a fixed-at-construction fake couldn't do that
 * without a new Spring context per test method, which would be far more
 * expensive). Defaults match Phase 3's original StubVerifyClient
 * (`gatesPassed: true`, 3 stars, composite 0.75) so tests that never call
 * a setter keep their original, already-passing behavior.
 */
public class FakeVerifyClient implements VerifyClient {

    public static final String FORCED_FAILURE_SCENARIO_ID = "verify-failure-trigger";

    private boolean gatesPassed = true;
    private int stars = 3;
    private double composite = 0.75;

    public void setGatesPassed(boolean gatesPassed) {
        this.gatesPassed = gatesPassed;
    }

    public void setStars(int stars) {
        this.stars = stars;
    }

    public void setComposite(double composite) {
        this.composite = composite;
    }

    /** Resets to the default "passing, 3 stars" response — call between test methods that share one Spring context. */
    public void reset() {
        gatesPassed = true;
        stars = 3;
        composite = 0.75;
    }

    @Override
    public VerifyResult verify(VerifyRequest request) {
        Object scenarioId = request.scenario().get("id");
        if (FORCED_FAILURE_SCENARIO_ID.equals(scenarioId)) {
            throw new VerifyException("Fake-forced verification failure for testing");
        }

        Map<String, Object> metrics = Map.of(
                "successRate", 0.97,
                "averageLatency", 45.0,
                "p95Latency", 120.0,
                "throughput", 250.0);
        Map<String, Object> evaluation = Map.of("passed", gatesPassed, "results", List.of());
        Map<String, Object> score = Map.of(
                "gatesPassed", gatesPassed,
                "composite", composite,
                "stars", stars,
                "legendary", stars == 5);
        return new VerifyResult(metrics, evaluation, score);
    }
}
