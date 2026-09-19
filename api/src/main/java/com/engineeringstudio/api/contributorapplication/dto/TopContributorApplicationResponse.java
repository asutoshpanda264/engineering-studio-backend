package com.engineeringstudio.api.contributorapplication.dto;

/**
 * One row of the admin's top-5 view — the application plus the exact stats
 * that produced its {@code priorityScore} (see
 * {@code ContributorApplicationPriority}), so an admin can see the numbers
 * behind the ranking, not just a trust-me score.
 */
public record TopContributorApplicationResponse(
        ContributorApplicationResponse application,
        String applicantDisplayName,
        long solvedCount,
        long totalPoints,
        int currentStreak,
        long priorityScore) {
}
