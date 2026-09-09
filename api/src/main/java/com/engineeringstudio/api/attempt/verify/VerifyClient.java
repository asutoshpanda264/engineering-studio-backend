package com.engineeringstudio.api.attempt.verify;

/**
 * The seam Phase 4 fills in with a real HTTP call to
 * engineering-studio-verify. AttemptService depends only on this
 * interface — swapping StubVerifyClient for a real implementation later
 * is a Spring bean-wiring change, not a rewrite of the attempt state
 * machine that calls it. See masterdoc/phase-3-attempt-state-machine/decisions.md.
 */
public interface VerifyClient {
    /** @throws VerifyException if the graph couldn't be verified (real impl: network/timeout failure). */
    VerifyResult verify(VerifyRequest request);
}
