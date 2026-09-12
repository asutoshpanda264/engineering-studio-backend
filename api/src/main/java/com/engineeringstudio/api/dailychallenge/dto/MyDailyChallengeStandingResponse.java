package com.engineeringstudio.api.dailychallenge.dto;

import java.time.LocalDate;

/** Streak numbers themselves live on GET /me (UserResponse) — this is just "did I already complete today's". */
public record MyDailyChallengeStandingResponse(LocalDate challengeDate, boolean completedToday) {
}
