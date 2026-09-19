package com.engineeringstudio.api.contributorapplication;

public enum ContributorApplicationStatus {
    /** Submitted, awaiting admin review. */
    PENDING,
    /** Approved — the applicant's `User.role` was flipped to CONTRIBUTOR in the same transaction. Terminal. */
    APPROVED,
    /** Rejected — no role change. Terminal. */
    REJECTED
}
