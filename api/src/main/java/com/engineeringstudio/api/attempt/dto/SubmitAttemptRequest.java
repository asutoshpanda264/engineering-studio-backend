package com.engineeringstudio.api.attempt.dto;

import jakarta.validation.constraints.NotNull;
import java.util.Map;

/**
 * `graph` is the client's submitted architecture ({nodes, connections} —
 * matching the frontend's own canvas shape) — deliberately untyped here
 * for the same reason ScenarioRequest's nested fields are (see
 * scenario/explain_scenario.md): this layer validates presence, not deep
 * structure. The verify-service (Phase 4) is what actually interprets it.
 */
public record SubmitAttemptRequest(@NotNull Map<String, Object> graph) {
}
