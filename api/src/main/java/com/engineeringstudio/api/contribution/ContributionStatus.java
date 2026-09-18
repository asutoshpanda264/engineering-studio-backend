package com.engineeringstudio.api.contribution;

public enum ContributionStatus {
    /** Submitted, awaiting admin review. */
    PENDING,
    /** Approved — points_awarded is set, reviewed_at/reviewed_by recorded. Terminal. */
    APPROVED,
    /** Rejected — reviewed_at/reviewed_by recorded, no points. Terminal. */
    REJECTED
}
