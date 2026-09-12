package com.engineeringstudio.api.dailychallenge.dto;

import com.engineeringstudio.api.dailychallenge.DailyChallenge;
import com.engineeringstudio.api.dailychallenge.DailyChallengeAssignedBy;
import com.engineeringstudio.api.scenario.Scenario;
import java.time.LocalDate;

public record DailyChallengeResponse(
        LocalDate challengeDate,
        String scenarioId,
        String scenarioTitle,
        short difficulty,
        DailyChallengeAssignedBy assignedBy) {

    public static DailyChallengeResponse of(DailyChallenge challenge, Scenario scenario) {
        return new DailyChallengeResponse(
                challenge.getChallengeDate(),
                scenario.getId(),
                scenario.getTitle(),
                scenario.getDifficulty(),
                challenge.getAssignedBy());
    }
}
