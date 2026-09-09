/**
 * The contract every infrastructure entity implements.
 *
 * From: SIMULATION-ENGINE.md §7 — "Entities Behave Independently"
 * The simulator never asks "how should a database work?" — it asks the
 * database. The simulator only delivers events; entities decide what
 * happens and hand back whatever new events result.
 *
 * Zero React dependencies.
 */

import type { EntityId, Timestamp } from "../types";
import type { SimulationEvent } from "../events/types";
import type { RNG } from "../engine/RNG";

/**
 * What an entity is allowed to know when handling an event — its own
 * outgoing connections and the current time. Never other entities' state,
 * never the queue itself (Local Knowledge, per ENTITIES.md).
 */
export interface SimulationContext {
  readonly now: Timestamp;
  readonly rng: RNG;
  /** Ids of entities this one has an outgoing connection to, in graph order. */
  readonly downstream: EntityId[];
  /** Configured latency (ms) to a given downstream entity; 0 if unconfigured. */
  latencyTo(targetId: EntityId): number;
}

export interface Entity {
  readonly id: EntityId;
  /**
   * React to a delivered event and return zero or more new events to
   * schedule. Must be deterministic given the same state, config, and
   * event (draw randomness only from ctx.rng).
   */
  handleEvent(event: SimulationEvent, ctx: SimulationContext): SimulationEvent[];
}
