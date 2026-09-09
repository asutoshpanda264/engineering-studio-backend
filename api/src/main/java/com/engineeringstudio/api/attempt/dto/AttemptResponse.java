package com.engineeringstudio.api.attempt.dto;

import com.engineeringstudio.api.attempt.AttemptMode;
import com.engineeringstudio.api.attempt.AttemptStatus;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;

public record AttemptResponse(
        UUID id,
        String scenarioId,
        int scenarioVersion,
        AttemptMode mode,
        AttemptStatus status,
        Instant startedAt,
        Instant submittedAt,
        int totalPausedSeconds,
        Integer elapsedSeconds,
        Map<String, Object> verifyMetrics,
        Map<String, Object> verifyEvaluation,
        Map<String, Object> verifyScore) {
}
