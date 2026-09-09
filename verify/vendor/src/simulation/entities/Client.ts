/**
 * The Client originates every request and is where the round trip ends.
 *
 * From: ENTITIES.md — "Client"
 * Users judge systems by outcomes, not architecture. The Client's only
 * job is to send work downstream; it does not track its own metrics —
 * MetricsCollector derives latency, success rate, etc. from the
 * REQUEST_COMPLETED / REQUEST_FAILED events addressed to it, after the
 * simulation finishes (SIMULATION-ENGINE.md §10 — "Metrics Are Emergent").
 *
 * Retry policy, timeout, and think-time (listed as Client config in
 * ENTITIES.md) are deferred — see SIMULATION-ENGINE.md §15, "Future
 * Evolution". Request generation itself is driven by the scenario's
 * traffic pattern (Simulator), not by per-client config, since only a
 * single client is supported for now.
 */

import type { Entity, SimulationContext } from "./Entity";
import type { EntityId } from "../types";
import type { SimulationEvent } from "../events/types";
import {
  createRequestFailedEvent,
  createRequestRoutedEvent,
} from "../events/EventFactory";

export interface ClientConfig {
  [key: string]: unknown;
}

export class Client implements Entity {
  readonly id: EntityId;

  constructor(id: EntityId) {
    this.id = id;
  }

  handleEvent(
    event: SimulationEvent,
    ctx: SimulationContext
  ): SimulationEvent[] {
    if (event.type !== "REQUEST_STARTED" || !event.requestId) {
      // REQUEST_COMPLETED / REQUEST_FAILED also arrive here — the
      // lifecycle simply ends at the client, nothing left to do.
      return [];
    }

    const target = ctx.downstream[0];
    if (!target) {
      return [
        createRequestFailedEvent(
          ctx.now,
          this.id,
          this.id,
          event.requestId,
          "no_downstream_connection"
        ),
      ];
    }

    const latency = ctx.latencyTo(target);
    const key = typeof event.metadata.key === "string" ? event.metadata.key : "key_0";
    const route = typeof event.metadata.route === "string" ? event.metadata.route : undefined;
    const exists = typeof event.metadata.exists === "boolean" ? event.metadata.exists : true;
    const requiresRelationshipTraversal =
      event.metadata.requiresRelationshipTraversal === true;
    return [
      createRequestRoutedEvent(
        ctx.now + latency,
        this.id,
        target,
        event.requestId,
        {
          startedAt: ctx.now,
          direction: "request",
          path: [this.id],
          key,
          exists,
          requiresRelationshipTraversal,
          ...(route !== undefined ? { route } : {}),
        }
      ),
    ];
  }
}
