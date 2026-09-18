package com.engineeringstudio.api.contribution;

/**
 * Fixed points per category, awarded once at approval — a pure, stateless,
 * static-method class, same shape as {@code points.PointsCalculator}, kept
 * separate from it since a contribution's award is a flat constant, not a
 * formula (no difficulty/stars/speed inputs to combine).
 */
public final class ContributionPointsCalculator {

    private ContributionPointsCalculator() {
    }

    public static int pointsFor(ContributionCategory category) {
        return switch (category) {
            case QUESTION -> 5;
            case POST -> 10;
            case VLOG -> 15;
        };
    }
}
