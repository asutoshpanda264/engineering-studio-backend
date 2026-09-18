package com.engineeringstudio.api.contribution.dto;

/**
 * One row of the admin queue — a pending contribution plus its submitting
 * contributor's total approved-contribution points, the queue's sort key
 * (highest-rated contributor first). Combines a `Contribution` with an
 * aggregate computed separately, the same "compose two reads into one
 * response" pattern `admin.AdminDailyChallengeController` uses when a
 * response needs more than one entity's worth of data.
 */
public record PendingContributionResponse(ContributionResponse contribution, long contributorApprovedPoints) {
}
