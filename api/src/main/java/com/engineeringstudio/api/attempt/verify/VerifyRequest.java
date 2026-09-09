package com.engineeringstudio.api.attempt.verify;

import java.util.Map;

/**
 * What crosses the boundary to engineering-studio-verify: the FULL
 * scenario body (constraints, budget, trafficPattern, seed, ...) at the
 * exact version this attempt was solved against, plus the submitted
 * graph — never a client-claimed score.
 *
 * `scenario` is deliberately the whole body, not a hand-picked subset of
 * "the fields I think scoring needs" — the verify-service is stateless
 * (no DB of its own), so Postgres, via this API, is the only source of
 * truth it ever sees for scenario content; sending everything means a
 * later scoring refinement (e.g. reading a field this service doesn't use
 * today) never requires a contract change on this side. See
 * masterdoc/phase-4-verify-service-integration/decisions.md.
 */
public record VerifyRequest(Map<String, Object> scenario, Map<String, Object> graph) {
}
