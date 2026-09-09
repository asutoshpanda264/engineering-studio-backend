package com.engineeringstudio.api.scenario;

import com.engineeringstudio.api.common.json.JsonUtil;
import com.engineeringstudio.api.scenario.dto.ScenarioRequest;
import com.engineeringstudio.api.scenario.dto.ScenarioResponse;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Component;
import tools.jackson.core.type.TypeReference;

/**
 * The one place JSON-string-in-the-database meets typed-object-in-Java —
 * every other class works with either a Scenario entity or a
 * ScenarioRequest/Response DTO, never raw JSON strings directly.
 */
@Component
public class ScenarioMapper {

    private static final TypeReference<List<String>> STRING_LIST = new TypeReference<>() {
    };
    private static final TypeReference<List<Map<String, Object>>> MAP_LIST = new TypeReference<>() {
    };
    private static final TypeReference<Map<String, Object>> MAP = new TypeReference<>() {
    };
    private static final TypeReference<Map<String, List<String>>> STRING_LIST_MAP = new TypeReference<>() {
    };

    /** Applies a request's fields onto a (possibly brand-new) entity. Caller owns id/version/status/audit fields. */
    public void applyRequest(ScenarioRequest request, Scenario target) {
        target.setTitle(request.title());
        target.setDifficulty(request.difficulty());
        target.setTopics(JsonUtil.toJson(request.topics()));
        target.setSuggestedTimeLimitMinutes(request.suggestedTimeLimitMinutes());
        target.setStory(request.story());
        target.setStartingEntities(JsonUtil.toJson(request.startingEntities()));
        target.setStartingConnections(JsonUtil.toJson(request.startingConnections()));
        target.setTrafficPattern(JsonUtil.toJson(request.trafficPattern()));
        target.setDurationMs(request.durationMs());
        target.setSeed(request.seed());
        target.setConstraints(JsonUtil.toJson(request.constraints()));
        target.setGivenNodeIds(JsonUtil.toJson(request.givenNodeIds()));
        target.setLockedFields(JsonUtil.toJson(request.lockedFields()));
        target.setBudgetUsd(request.budgetUsd());
        target.setRequiresGatedToolCalls(request.requiresGatedToolCalls());
        target.setHints(JsonUtil.toJson(request.hints()));
        target.setLearningGoals(JsonUtil.toJson(request.learningGoals()));
        target.setCapacityEstimate(JsonUtil.toJson(request.capacityEstimate()));
        target.setReflection(JsonUtil.toJson(request.reflection()));
        target.setOptimalSolution(JsonUtil.toJson(request.optimalSolution()));
    }

    public ScenarioResponse toResponse(Scenario s) {
        return new ScenarioResponse(
                s.getId(),
                s.getVersion(),
                s.getStatus(),
                s.getTitle(),
                s.getDifficulty(),
                JsonUtil.fromJson(s.getTopics(), STRING_LIST),
                s.getSuggestedTimeLimitMinutes(),
                s.getStory(),
                JsonUtil.fromJson(s.getStartingEntities(), MAP_LIST),
                JsonUtil.fromJson(s.getStartingConnections(), MAP_LIST),
                JsonUtil.fromJson(s.getTrafficPattern(), MAP),
                s.getDurationMs(),
                s.getSeed(),
                JsonUtil.fromJson(s.getConstraints(), MAP_LIST),
                JsonUtil.fromJson(s.getGivenNodeIds(), STRING_LIST),
                JsonUtil.fromJson(s.getLockedFields(), STRING_LIST_MAP),
                s.getBudgetUsd(),
                s.isRequiresGatedToolCalls(),
                JsonUtil.fromJson(s.getHints(), STRING_LIST),
                JsonUtil.fromJson(s.getLearningGoals(), STRING_LIST),
                JsonUtil.fromJson(s.getCapacityEstimate(), MAP),
                JsonUtil.fromJson(s.getReflection(), MAP),
                JsonUtil.fromJson(s.getOptimalSolution(), MAP),
                s.getCreatedBy(),
                s.getCreatedAt(),
                s.getUpdatedAt());
    }

    /** The full entity state, captured as one JSON blob for scenario_versions.snapshot. */
    public String toSnapshotJson(Scenario s) {
        return JsonUtil.toJson(toResponse(s));
    }
}
