package com.engineeringstudio.api.bugreport;

public enum BugReportStatus {
    /** Filed, not yet triaged. */
    OPEN,
    /** An admin is actively working it. */
    IN_PROGRESS,
    /** Fixed/closed — the only status that sets `resolvedAt`. */
    RESOLVED
}
