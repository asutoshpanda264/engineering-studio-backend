package com.engineeringstudio.api.scenario.dto;

import com.engineeringstudio.api.scenario.ScenarioStatus;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

public record ScenarioResponse(
        String id,
        int version,
        ScenarioStatus status,
        String title,
        short difficulty,
        List<String> topics,
        Integer suggestedTimeLimitMinutes,
        String story,
        List<Map<String, Object>> startingEntities,
        List<Map<String, Object>> startingConnections,
        Map<String, Object> trafficPattern,
        int durationMs,
        int seed,
        List<Map<String, Object>> constraints,
        List<String> givenNodeIds,
        Map<String, List<String>> lockedFields,
        BigDecimal budgetUsd,
        boolean requiresGatedToolCalls,
        List<String> hints,
        List<String> learningGoals,
        Map<String, Object> capacityEstimate,
        Map<String, Object> reflection,
        Map<String, Object> optimalSolution,
        UUID createdBy,
        Instant createdAt,
        Instant updatedAt) {
}
