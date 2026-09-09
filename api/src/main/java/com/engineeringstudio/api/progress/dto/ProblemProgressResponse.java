package com.engineeringstudio.api.progress.dto;

import com.engineeringstudio.api.progress.ProblemProgress;
import com.engineeringstudio.api.progress.ProblemProgressStatus;
import java.math.BigDecimal;
import java.time.Instant;

public record ProblemProgressResponse(
        String scenarioId,
        ProblemProgressStatus status,
        short bestStars,
        int bestPoints,
        BigDecimal bestComposite,
        BigDecimal bestSpeedFactor,
        Instant firstSolvedAt,
        Instant lastAttemptAt) {

    public static ProblemProgressResponse from(ProblemProgress p) {
        return new ProblemProgressResponse(
                p.getScenarioId(),
                p.getStatus(),
                p.getBestStars(),
                p.getBestPoints(),
                p.getBestComposite(),
                p.getBestSpeedFactor(),
                p.getFirstSolvedAt(),
                p.getLastAttemptAt());
    }
}
