package com.engineeringstudio.api.contributorapplication;

/**
 * The whole "who's a strong contributor candidate" formula, as one pure,
 * stateless, static-method class — same shape as
 * {@code points.PointsCalculator}. First-pass weights, deliberately simple
 * (2025-09-19 chat): this project has too few users with substantial solve
 * histories yet for anything more elaborate (percentile normalization,
 * etc.) to mean much — revisit once there's real distribution to tune
 * against. {@code solvedCount}/{@code totalPoints} come from
 * {@code ProblemProgressRepository.aggregateLeaderboardStats} (the exact
 * numbers the real leaderboards are built from, not a separate
 * computation), {@code currentStreak} from {@code User.currentStreak}.
 */
public final class ContributorApplicationPriority {

    private static final long SOLVED_COUNT_WEIGHT = 20;
    private static final long STREAK_WEIGHT = 10;

    private ContributorApplicationPriority() {
    }

    public static long score(long solvedCount, long totalPoints, int currentStreak) {
        return totalPoints + solvedCount * SOLVED_COUNT_WEIGHT + (long) currentStreak * STREAK_WEIGHT;
    }
}
