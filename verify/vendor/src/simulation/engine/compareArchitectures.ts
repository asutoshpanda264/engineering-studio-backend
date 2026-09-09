/**
 * Splices one entity out of a SimulationConfig, rerouting whatever fed it
 * straight to its own downstream — the building block for "what would
 * this look like WITHOUT this component" comparisons (e.g. "how much
 * does a CDN actually save?"). The caller runs the result through
 * runSimulation exactly like any other config, so the comparison is a
 * genuine second simulation, not an estimate.
 *
 * The spliced connection reuses the removed entity's own OUTGOING
 * latency, not the incoming one — bypassing a CDN should mean "the
 * client now has to reach the true origin directly" (the CDN's own
 * distance to that origin), not "the client only travels as far as the
 * nearest edge used to be." Using the incoming latency instead would
 * make "without CDN" look unrealistically fast and undersell the point.
 *
 * Determinism (SIMULATION-ENGINE.md §9) is what makes the comparison
 * fair in the first place: run both configs with the same seed and every
 * other entity's config unchanged, and the only variable is whether this
 * one entity exists.
 */

import type { EntityId, SimulationConfig } from "../types";

export function removeEntityAndReroute(
  config: SimulationConfig,
  entityId: EntityId
): SimulationConfig | null {
  const entity = config.entities.find((e) => e.id === entityId);
  if (!entity) return null;

  // Our engine only ever routes to downstream[0], so only the first
  // outgoing connection is ever actually used — reroute through that one.
  const outgoing = config.connections.find((c) => c.source === entityId);
  const incoming = config.connections.filter((c) => c.target === entityId);
  if (!outgoing || incoming.length === 0) return null;

  const rerouted = incoming.map((connection) => ({
    ...connection,
    target: outgoing.target,
    latencyMs: outgoing.latencyMs,
  }));

  return {
    ...config,
    entities: config.entities.filter((e) => e.id !== entityId),
    connections: config.connections
      .filter((c) => c.source !== entityId && c.target !== entityId)
      .concat(rerouted),
  };
}
