package com.engineeringstudio.api.scenario.dto;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Positive;
import java.math.BigDecimal;
import java.util.List;
import java.util.Map;

/**
 * Used for both create (POST /scenarios) and update (PUT /scenarios/{id}).
 * Deliberately loose typing (Map/List of Object) for the deeply-nested
 * fields (startingEntities, trafficPattern, constraints, ...) — this layer
 * validates shape (is it present, is it the right top-level JSON kind), not
 * the full structural correctness of e.g. a TrafficPattern's discriminated
 * union, which would require re-encoding the frontend's whole type system
 * in Bean Validation for marginal benefit over what the simulation-verify
 * service (a later phase) already has to check when it actually runs the
 * thing.
 */
public record ScenarioRequest(
        @NotBlank @Pattern(regexp = "^[a-z0-9]+(-[a-z0-9]+)*$", message = "must be a lowercase kebab-case slug")
        @jakarta.validation.constraints.Size(max = 80) String id,

        @NotBlank @jakarta.validation.constraints.Size(max = 200) String title,

        @Min(1) @Max(5) short difficulty,

        @NotEmpty List<String> topics,

        @Positive Integer suggestedTimeLimitMinutes,

        @NotBlank String story,

        @NotNull List<Map<String, Object>> startingEntities,

        @NotNull List<Map<String, Object>> startingConnections,

        @NotNull Map<String, Object> trafficPattern,

        @Positive int durationMs,

        int seed,

        @NotEmpty List<Map<String, Object>> constraints,

        List<String> givenNodeIds,

        Map<String, List<String>> lockedFields,

        @Positive BigDecimal budgetUsd,

        boolean requiresGatedToolCalls,

        @NotNull List<String> hints,

        @NotEmpty List<String> learningGoals,

        Map<String, Object> capacityEstimate,

        Map<String, Object> reflection,

        Map<String, Object> optimalSolution) {
}
