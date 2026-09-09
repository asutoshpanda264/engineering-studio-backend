/**
 * The CircuitBreaker wraps exactly one downstream target and stops
 * sending it traffic once it looks unhealthy — a protective proxy, not a
 * router (contrast with LoadBalancer, which routes across many targets;
 * this one only ever has one).
 *
 * A three-state machine, same shape a real circuit breaker uses:
 *
 * - Closed: forwards every request normally. Counts *consecutive*
 *   failures on the response leg (now genuinely observable — see
 *   Database.ts's `fail()` helper and the failure-routing fix that
 *   shipped alongside this entity, without which a downstream failure
 *   would never reach here at all). A success resets the streak to zero.
 *   Once consecutiveFailures reaches failureThreshold, it trips open.
 * - Open: fails every request immediately, without forwarding to the
 *   downstream target at all — that's the entire point, giving a
 *   struggling dependency room to recover instead of piling more load
 *   onto it. After tripDurationMs has passed, the next arriving request
 *   is let through as a single probe and the breaker moves to half-open.
 * - Half-open: lets up to halfOpenMaxProbes requests through as trials;
 *   anything beyond that still fails fast (still protecting the
 *   dependency while probing). A probe succeeding closes the breaker
 *   (failure streak resets); a probe failing reopens it immediately.
 *
 * Response handling runs the same regardless of current state — a
 * response can't be dropped just because the breaker tripped in the
 * meantime — but *what it does* with a response differs: while closed it
 * counts toward the trip threshold, while half-open it's the specific
 * probe outcome the state transition decision hinges on, and while open
 * it's a stale response from before the trip and is just forwarded,
 * changing nothing.
 *
 * Every state transition emits its own event (CIRCUIT_OPENED/CLOSED/
 * HALF_OPENED) — Observable Behavior: a breaker's state has to be
 * something a student can actually see change, not just infer.
 *
 * Learning goal: retrying (or routing to) a dependency that's already
 * failing doesn't help it recover — it adds load to something already
 * struggling, and can cascade the failure upstream. Failing fast and
 * giving the dependency room to recover, then cautiously checking back
 * in, is a different tradeoff than a Load Balancer's "spread the load"
 * or a Rate Limiter's "cap the load" — this is "stop the load entirely,
 * temporarily."
 */

import type { Entity, SimulationContext } from "./Entity";
import type { EntityId, RequestId } from "../types";
import type {
  RequestLifecycleMetadata,
  SimulationEvent,
} from "../events/types";
import { findResponseTarget } from "./responseRouting";
import {
  createCircuitStateEvent,
  createRequestCompletedEvent,
  createRequestFailedEvent,
  createRequestRoutedEvent,
} from "../events/EventFactory";

export type CircuitBreakerState = "closed" | "open" | "half_open";

export interface CircuitBreakerConfig {
  /** Consecutive failures (while closed) before tripping open. */
  failureThreshold?: number;
  /** How long the breaker stays open before letting a probe through. */
  tripDurationMs?: number;
  /** Requests allowed through concurrently while half-open. */
  halfOpenMaxProbes?: number;
}

const DEFAULTS: Required<CircuitBreakerConfig> = {
  failureThreshold: 5,
  tripDurationMs: 5000,
  halfOpenMaxProbes: 1,
};

export class CircuitBreaker implements Entity {
  readonly id: EntityId;

  private readonly config: Required<CircuitBreakerConfig>;

  private state: CircuitBreakerState = "closed";
  private consecutiveFailures = 0;
  private openedAt = 0;
  private probesInFlight = 0;
  /**
   * "Closed and never tripped" is the most common state a breaker will
   * ever be in, but it's also the one state with no natural transition
   * event to hang a metric off of — CIRCUIT_OPENED/CLOSED/HALF_OPENED
   * only fire on an actual change. Without this, a healthy breaker would
   * never appear in metrics.circuitBreaker at all, silently hiding the
   * Inspector's state badge for the common case (Observable Behavior
   * requires the opposite: closed-and-healthy should be the easiest
   * state to see, not the one that's invisible).
   */
  private hasReportedInitialState = false;

  constructor(id: EntityId, config: CircuitBreakerConfig = {}) {
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

    const initialStateEvent = this.hasReportedInitialState
      ? []
      : [createCircuitStateEvent("CIRCUIT_CLOSED", ctx.now, this.id, event.requestId)];
    this.hasReportedInitialState = true;

    const meta = event.metadata as RequestLifecycleMetadata;

    if (meta.direction === "response") {
      return [...initialStateEvent, ...this.onResponse(meta, ctx, event.requestId)];
    }
    return [...initialStateEvent, ...this.onRequest(meta, ctx, event.requestId)];
  }

  private onRequest(
    meta: RequestLifecycleMetadata,
    ctx: SimulationContext,
    requestId: RequestId
  ): SimulationEvent[] {
    if (ctx.downstream.length === 0) {
      return this.fail(meta, ctx, requestId, "no_downstream_connection");
    }

    if (this.state === "open") {
      if (ctx.now - this.openedAt < this.config.tripDurationMs) {
        return this.fail(meta, ctx, requestId, "circuit_open");
      }
      // Trial period over — let this one through as the probe.
      this.state = "half_open";
      this.probesInFlight = 1;
      return [
        createCircuitStateEvent("CIRCUIT_HALF_OPENED", ctx.now, this.id, requestId),
        ...this.forwardRequest(meta, ctx, requestId),
      ];
    }

    if (this.state === "half_open") {
      if (this.probesInFlight >= this.config.halfOpenMaxProbes) {
        return this.fail(meta, ctx, requestId, "circuit_open");
      }
      this.probesInFlight++;
      return this.forwardRequest(meta, ctx, requestId);
    }

    return this.forwardRequest(meta, ctx, requestId);
  }

  private onResponse(
    meta: RequestLifecycleMetadata,
    ctx: SimulationContext,
    requestId: RequestId
  ): SimulationEvent[] {
    const events = this.forwardResponse(meta, ctx, requestId);

    if (this.state === "closed") {
      if (meta.failed) {
        this.consecutiveFailures++;
        if (this.consecutiveFailures >= this.config.failureThreshold) {
          this.trip(ctx.now);
          events.push(createCircuitStateEvent("CIRCUIT_OPENED", ctx.now, this.id, requestId));
        }
      } else {
        this.consecutiveFailures = 0;
      }
    } else if (this.state === "half_open") {
      this.probesInFlight = Math.max(0, this.probesInFlight - 1);
      if (meta.failed) {
        this.trip(ctx.now);
        events.push(createCircuitStateEvent("CIRCUIT_OPENED", ctx.now, this.id, requestId));
      } else {
        this.state = "closed";
        this.consecutiveFailures = 0;
        events.push(createCircuitStateEvent("CIRCUIT_CLOSED", ctx.now, this.id, requestId));
      }
    }
    // state === "open": a stale response from before the trip — forward
    // it (already done above) and nothing else, the trip already stands.

    return events;
  }

  private trip(now: number): void {
    this.state = "open";
    this.openedAt = now;
    this.consecutiveFailures = 0;
    this.probesInFlight = 0;
  }

  private forwardRequest(
    meta: RequestLifecycleMetadata,
    ctx: SimulationContext,
    requestId: RequestId
  ): SimulationEvent[] {
    const target = ctx.downstream[0];
    const latency = ctx.latencyTo(target);
    return [
      createRequestRoutedEvent(ctx.now + latency, this.id, target, requestId, {
        ...meta,
        direction: "request",
        path: [...meta.path, this.id],
      }),
    ];
  }

  /** Instant pass-through — no capacity check, same reasoning as LoadBalancer. */
  private forwardResponse(
    meta: RequestLifecycleMetadata,
    ctx: SimulationContext,
    requestId: RequestId
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
    requestId: RequestId,
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
