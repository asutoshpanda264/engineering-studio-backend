package com.engineeringstudio.api.attempt;

/**
 * IN_PROGRESS → PAUSED ⇄ IN_PROGRESS → SUBMITTED is the normal path.
 * VERIFY_FAILED is the anti-cheat-safe error state: the verify-service call
 * (real in Phase 4, stubbed for now) failed or timed out, nothing was
 * scored or awarded, and the attempt stays resubmittable — see
 * AttemptService.submit and decisions.md. EXPIRED is reserved for a future
 * "attempt sat open too long" cleanup job — not implemented yet, no code
 * transitions an attempt to it today.
 */
public enum AttemptStatus {
    IN_PROGRESS,
    PAUSED,
    SUBMITTED,
    VERIFY_FAILED,
    EXPIRED
}
