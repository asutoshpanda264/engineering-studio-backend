package com.engineeringstudio.api.contribution.dto;

import com.engineeringstudio.api.contribution.ContributionCategory;
import com.engineeringstudio.api.contribution.ContributionStatus;
import java.time.Instant;
import java.util.UUID;

public record ContributionResponse(
        UUID id,
        UUID contributorId,
        ContributionCategory category,
        String title,
        String body,
        String link,
        ContributionStatus status,
        int pointsAwarded,
        Instant reviewedAt,
        UUID reviewedBy,
        Instant createdAt,
        Instant updatedAt) {
}
