package com.engineeringstudio.api.leaderboard;

import com.engineeringstudio.api.common.error.ApiException;
import org.springframework.http.HttpStatus;

/**
 * The 3 leaderboards from the milestone plan, each backed by its own
 * Redis ZSET, member = {@code userId.toString()}. Score direction is
 * uniformly "higher is better" across all three — including FASTEST_SOLVED,
 * whose score is {@link com.engineeringstudio.api.points.PointsCalculator#speedFactor}
 * (bigger = faster relative to the scenario's time limit), not raw
 * elapsed seconds, specifically so one ranking convention (ZREVRANGE,
 * ZREVRANK) works for every board — see decisions.md.
 *
 * <p>NO_PRESSURE-mode solves never appear on any of these — see
 * {@code attempt.AttemptMode}'s own Javadoc ("excluded from every
 * leaderboard"), a Phase 3 decision this milestone honors rather than
 * revisits. See {@link com.engineeringstudio.api.progress.ProblemProgressRepository#aggregateLeaderboardStats}
 * for exactly how that's enforced.
 */
public enum LeaderboardType {
    MOST_SOLVED("most-solved"),
    BEST_SOLVED("best-solved"),
    FASTEST_SOLVED("fastest-solved");

    private final String slug;

    LeaderboardType(String slug) {
        this.slug = slug;
    }

    public String slug() {
        return slug;
    }

    public String redisKey() {
        return "leaderboard:" + slug;
    }

    /** Parses a URL path segment (e.g. "most-solved") — used by LeaderboardController instead of Spring's own enum path-variable binding, matching this codebase's existing style of a plain String @PathVariable + an explicit ApiException on bad input (see ScenarioController). */
    public static LeaderboardType fromSlug(String slug) {
        for (LeaderboardType type : values()) {
            if (type.slug.equals(slug)) {
                return type;
            }
        }
        throw new ApiException(HttpStatus.BAD_REQUEST, "Unknown leaderboard type: " + slug);
    }
}
