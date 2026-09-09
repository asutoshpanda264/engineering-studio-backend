/**
 * The ReplicaPool routes reads and writes differently across a leader and
 * its read replicas — a leader accepts writes, replicas serve reads, so
 * read traffic can scale horizontally without adding write capacity
 * (which a single leader can't be split across).
 *
 * Deliberately thin, like LoadBalancer — no capacity or processing model
 * of its own. `ctx.downstream[0]` is the leader by convention (the first
 * connection drawn from this node); everything after it is a read
 * replica. Each is a real Database/APIServer node the user wires on
 * canvas, so replica capacity, latency, and failure behavior are
 * whatever that node's own config already models — this entity only
 * makes the routing decision, exactly like a Load Balancer only decides
 * which server, not how fast that server is.
 *
 * The read/write split is a config knob on the pool itself
 * (writeRatio), rolled per-request via the seeded RNG — the same
 * self-contained pattern Database's failureProbability uses. Nothing
 * upstream tags a request as a read or a write (Client is generic, by
 * design — Local Knowledge), so the pool has to decide for itself.
 *
 * Replication lag is real in actual replica setups, but modeling it
 * would mean simulating read staleness — a step into CAP-theorem-style
 * consistency modeling that's explicitly out of scope here. Rather than
 * ship a "Replication Lag" knob that quietly does nothing (which would
 * be worse than not having it — a config value a curious student changes
 * and sees zero effect from), the tradeoff is explained in prose in
 * entityEducation.ts instead.
 *
 * Reuses LoadBalancer's per-target request-distribution metric as-is
 * (see MetricsCollector's routingByEntity/routingDistribution, and
 * InspectorPanel's LoadBalancerDistributionSection) — this entity emits
 * REQUEST_ROUTED exactly like LoadBalancer does, so no new metrics
 * plumbing is needed; the canvas topology itself (which connection was
 * drawn first) communicates which bar is the leader.
 *
 * Learning goal: a single leader can't be split across machines the way
 * a stateless server can — replicating it for reads is a different lever
 * than the horizontal scaling a Load Balancer teaches, with its own
 * tradeoff (replica reads can lag behind the leader).
 */

import type { Entity, SimulationContext } from "./Entity";
import type { EntityId } from "../types";
import type {
  RequestLifecycleMetadata,
  SimulationEvent,
} from "../events/types";
import { findResponseTarget } from "./responseRouting";
import {
  createRequestCompletedEvent,
  createRequestFailedEvent,
  createRequestRoutedEvent,
} from "../events/EventFactory";

export interface ReplicaPoolConfig {
  /** Fraction (0-1) of requests treated as writes, routed to the leader. The rest are reads, spread round-robin across the remaining connections. */
  writeRatio?: number;
}

const DEFAULTS: Required<ReplicaPoolConfig> = {
  writeRatio: 0.1,
};

export class ReplicaPool implements Entity {
  readonly id: EntityId;

  private readonly config: Required<ReplicaPoolConfig>;
  private nextReplicaIndex = 0;

  constructor(id: EntityId, config: ReplicaPoolConfig = {}) {
    this.id = id;
    this.config = { ...DEFAULTS, ...config };
  }

  handleEvent(
    event: SimulationEvent,
    ctx: SimulationContext
  ): SimulationEvent[] {
    if (event.type !== "REQUEST_ROUTED" || event.destination !== this.id) {
      return [];
    }
    if (!event.requestId) return [];

    const meta = event.metadata as RequestLifecycleMetadata;

    if (meta.direction === "response") {
      return this.forwardResponse(meta, ctx, event.requestId);
    }

    if (ctx.downstream.length === 0) {
      return this.fail(meta, ctx, event.requestId, "no_downstream_connection");
    }

    const target = this.selectTarget(ctx.downstream, ctx);
    const latency = ctx.latencyTo(target);
    return [
      createRequestRoutedEvent(ctx.now + latency, this.id, target, event.requestId, {
        ...meta,
        direction: "request",
        path: [...meta.path, this.id],
      }),
    ];
  }

  private selectTarget(downstream: EntityId[], ctx: SimulationContext): EntityId {
    const leader = downstream[0];
    const replicas = downstream.slice(1);

    // No replicas configured yet — the pool still works, it just can't
    // demonstrate anything (same graceful-degradation tolerance
    // LoadBalancer has with a single target).
    if (replicas.length === 0) return leader;

    const isWrite = ctx.rng.next() < this.config.writeRatio;
    if (isWrite) return leader;

    const target = replicas[this.nextReplicaIndex % replicas.length];
    this.nextReplicaIndex++;
    return target;
  }

  /** Instant pass-through — no capacity check, same reasoning as LoadBalancer. */
  private forwardResponse(
    meta: RequestLifecycleMetadata,
    ctx: SimulationContext,
    requestId: string
  ): SimulationEvent[] {
    const { target, isClient } = findResponseTarget(this.id, meta.path);
    const latency = ctx.latencyTo(target);

    if (isClient) {
      const duration = ctx.now + latency - meta.startedAt;
      return [
        meta.failed
          ? createRequestFailedEvent(
              ctx.now + latency,
              this.id,
              target,
              requestId,
              meta.failureReason ?? "unknown",
              { startedAt: meta.startedAt }
            )
          : createRequestCompletedEvent(
              ctx.now + latency,
              this.id,
              target,
              requestId,
              duration
            ),
      ];
    }

    return [
      createRequestRoutedEvent(ctx.now + latency, this.id, target, requestId, {
        ...meta,
        direction: "response",
        path: meta.path,
      }),
    ];
  }

  /** Routes a local failure via findResponseTarget instead of straight to the client — see Database.ts's identical helper. */
  private fail(
    meta: RequestLifecycleMetadata,
    ctx: SimulationContext,
    requestId: string,
    reason: string
  ): SimulationEvent[] {
    const { target, isClient } = findResponseTarget(this.id, meta.path);
    if (isClient) {
      return [
        createRequestFailedEvent(ctx.now, this.id, target, requestId, reason, {
          startedAt: meta.startedAt,
        }),
      ];
    }
    const latency = ctx.latencyTo(target);
    return [
      createRequestRoutedEvent(ctx.now + latency, this.id, target, requestId, {
        ...meta,
        direction: "response",
        path: meta.path,
        failed: true,
        failureReason: reason,
      }),
    ];
  }
}
