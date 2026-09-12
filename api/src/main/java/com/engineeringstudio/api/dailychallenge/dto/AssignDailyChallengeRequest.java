package com.engineeringstudio.api.dailychallenge.dto;

import jakarta.validation.constraints.NotBlank;

public record AssignDailyChallengeRequest(@NotBlank String scenarioId) {
}
