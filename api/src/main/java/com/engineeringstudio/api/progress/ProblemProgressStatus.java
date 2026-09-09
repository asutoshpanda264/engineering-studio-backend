package com.engineeringstudio.api.progress;

/**
 * ATTEMPTED — at least one submit happened, none passed the scenario's
 * gates yet. SOLVED — at least one submit had `gatesPassed = true`. Once
 * SOLVED, a row never goes back to ATTEMPTED (re-solving worse just
 * doesn't upgrade `best_*`, per the upgrade-only design — see
 * decisions.md).
 */
public enum ProblemProgressStatus {
    ATTEMPTED,
    SOLVED
}
