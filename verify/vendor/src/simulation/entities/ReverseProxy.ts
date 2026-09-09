/**
 * The Reverse Proxy routes each request to a specific downstream service
 * based on which named route it's addressed to — not to any of several
 * interchangeable replicas of the same service, which is Load Balancer's
 * job. This is the distinction the two entities are deliberately built to
 * keep separate: Load Balancer spreads identical work across a
 * homogeneous pool; Reverse Proxy sends different kinds of work to
 * different, heterogeneous destinations (an API gateway / nginx
 * `location` block pattern — `/orders` to the Orders service, `/users` to
 * the Users service).
 *
 * Real reverse proxies route on the actual HTTP request path. This engine
 * has no path-shaped request data — every request only carries a `key`
 * (a resource id, deliberately skewed so a Cache has something to hit on)
 * — so routing needed its own, independent request dimension:
 * `RequestLifecycleMetadata.route`, drawn uniformly from a small fixed
 * pool of realistic-looking service names (TrafficGenerator.ROUTE_LABELS)
 * via the Client's Route Pool Size config. A documented substitution for
 * a real path, the same way Load Balancer's IP Hash substitutes `key` for
 * a real client IP.
 *
 * Routes live on the Reverse Proxy's own config (`routes`, target entity
 * id -> the one route label that target owns) — Local Knowledge, same
 * reasoning as Load Balancer's weights: a proxy can't know what a target
 * serves except what an operator tells it. A target with no configured
 * route, or a route value that never matches, simply never receives
 * traffic — nothing routes there by accident. A target explicitly
 * configured with `"*"` is the catch-all: it receives anything no other
 * target's specific route claimed, mirroring nginx's default_server.
 *
 * Like Load Balancer, this entity has no capacity of its own — an instant
 * routing decision, then forward. Modeling its own backpressure would
 * conflate "which service should handle this kind of request" with "is
 * that service too busy", which Client/API/Database already teach.
 *
 * Learning goal: routing and load-spreading are different problems that
 * happen to sit in the same spot in a request's path. A Load Balancer
 * with five different config sections could theoretically also do
 * path-based routing, but bolting it on would blur exactly the line
 * ENTITIES.md's Single Responsibility principle exists to keep sharp —
 * two entities, two jobs, composable in the same graph.
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

/** Any target configured with this exact value catches whatever no other target's specific route claimed. */
export const CATCH_ALL_ROUTE = "*";

export interface ReverseProxyConfig {
  /** Target entity id -> the one route label it owns (or CATCH_ALL_ROUTE). A target with no entry never receives traffic. */
  routes?: Record<EntityId, string>;
}

const DEFAULTS: Required<ReverseProxyConfig> = {
  routes: {},
};

export class ReverseProxy implements Entity {
  readonly id: EntityId;

  private readonly config: Required<ReverseProxyConfig>;

  constructor(id: EntityId, config: ReverseProxyConfig = {}) {
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

    const target = this.selectTarget(ctx.downstream, meta.route);
    if (!target) {
      return this.fail(meta, ctx, event.requestId, "no_matching_route");
    }

    const latency = ctx.latencyTo(target);
    return [
      createRequestRoutedEvent(
        ctx.now + latency,
        this.id,
        target,
        event.requestId,
        {
          ...meta,
          direction: "request",
          path: [...meta.path, this.id],
        }
      ),
    ];
  }

  /**
   * An exact match on the request's route wins; a target configured as
   * the catch-all is only used once nothing more specific claimed it.
   *
   * A Reverse Proxy with `routes` still completely empty — freshly
   * connected, nothing typed into the Routes section yet — falls back to
   * its first downstream target instead of matching nothing. Every other
   * entity here is useful the instant it's wired up (Load Balancer
   * defaults to round_robin, Cache to LRU, ...); without this, a Reverse
   * Proxy would be the one entity that fails 100% of its traffic by
   * construction until an operator opens the Inspector and configures a
   * route by hand. Once *any* route is configured, this fallback stops
   * applying and the real "unmatched routes get nothing" semantics below
   * take over exactly as documented — that's the intentional lesson for
   * an operator who configured some routes but not this target's.
   */
  private selectTarget(downstream: EntityId[], route: string | undefined): EntityId | null {
    if (Object.keys(this.config.routes).length === 0) {
      return downstream[0] ?? null;
    }

    if (route !== undefined) {
      const exact = downstream.find((target) => this.config.routes[target] === route);
      if (exact) return exact;
    }
    const catchAll = downstream.find(
      (target) => this.config.routes[target] === CATCH_ALL_ROUTE
    );
    return catchAll ?? null;
  }

  /** Instant pass-through — no capacity check, same reasoning as the class doc. */
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
