package com.engineeringstudio.api.progress;

/**
 * Spring Data JPA interface projection for
 * {@link ProblemProgressRepository#aggregateLeaderboardStats}. Lives here
 * rather than in the `leaderboard` package deliberately — it's a shape
 * over `problem_progress` columns, not leaderboard-owned vocabulary, and
 * keeping it in `progress` means `leaderboard` depends on `progress` in
 * one direction only (repository, this projection, and
 * ProblemProgressUpgradedEvent), never the reverse.
 */
public interface ProblemProgressLeaderboardStats {
    long getSolvedCount();

    long getTotalPoints();

    Double getAvgSpeedFactor();
}
