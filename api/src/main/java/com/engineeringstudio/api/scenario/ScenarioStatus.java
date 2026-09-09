package com.engineeringstudio.api.scenario;

/**
 * DRAFT — created by a contributor (or admin), not visible on the public
 * catalog. PUBLISHED — live, visible via GET /scenarios, attemptable.
 * ARCHIVED — was published, pulled from the catalog, but its row (and every
 * Attempt/ProblemProgress that ever referenced it) stays intact — archiving
 * is how a scenario is retired without breaking historical data, which a
 * hard delete would.
 */
public enum ScenarioStatus {
    DRAFT,
    PUBLISHED,
    ARCHIVED
}
