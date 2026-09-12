package com.engineeringstudio.api.leaderboard.dto;

import com.engineeringstudio.api.leaderboard.LeaderboardType;

/**
 * `ranked = false` (rank/score both null) is a normal, expected response —
 * not an error — for a user who hasn't earned a leaderboard-eligible
 * TIMED solve yet. `rank` is 1-based.
 */
public record MyLeaderboardStandingResponse(LeaderboardType type, boolean ranked, Integer rank, Double score) {
}
