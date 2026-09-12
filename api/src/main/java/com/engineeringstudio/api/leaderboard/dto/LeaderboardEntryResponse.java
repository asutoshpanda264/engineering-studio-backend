package com.engineeringstudio.api.leaderboard.dto;

import java.util.UUID;

/** One row of a top-N leaderboard listing. `rank` is 1-based. */
public record LeaderboardEntryResponse(int rank, UUID userId, String displayName, double score) {
}
