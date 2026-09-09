package com.engineeringstudio.api.attempt.dto;

import com.engineeringstudio.api.attempt.AttemptMode;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;

public record StartAttemptRequest(@NotBlank String scenarioId, @NotNull AttemptMode mode) {
}
