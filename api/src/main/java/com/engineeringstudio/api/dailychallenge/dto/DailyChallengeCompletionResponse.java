package com.engineeringstudio.api.dailychallenge.dto;

import com.engineeringstudio.api.dailychallenge.DailyChallengeCompletion;
import java.time.Instant;
import java.time.LocalDate;

public record DailyChallengeCompletionResponse(LocalDate challengeDate, String scenarioId, String mode, Instant completedAt) {
    public static DailyChallengeCompletionResponse from(DailyChallengeCompletion completion) {
        return new DailyChallengeCompletionResponse(
                completion.getChallengeDate(), completion.getScenarioId(), completion.getMode(), completion.getCompletedAt());
    }
}
