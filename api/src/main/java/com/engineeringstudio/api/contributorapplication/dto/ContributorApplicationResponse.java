package com.engineeringstudio.api.contributorapplication.dto;

import com.engineeringstudio.api.contributorapplication.ContributorApplicationStatus;
import java.time.Instant;
import java.util.UUID;

public record ContributorApplicationResponse(
        UUID id,
        UUID applicantId,
        ContributorApplicationStatus status,
        Instant reviewedAt,
        UUID reviewedBy,
        Instant createdAt,
        Instant updatedAt) {
}
