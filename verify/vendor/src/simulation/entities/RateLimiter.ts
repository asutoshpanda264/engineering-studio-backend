/**
 * The RateLimiter admits requests up to a configured rate and rejects the
 * rest outright — no queue, no buffer. Contrast with APIServer/Database
 * (queue-then-process) and MessageQueue (buffer-then-dispatch): here,
 * backpressure means "say no immediately," not "make it wait."
 *
 * Two algorithms ship, so the difference between them is something a
 * student can actually see rather than just being told about (same
 * reasoning as LoadBalancer's round-robin vs least-connections):
 *
 * - Token Bucket: a bucket refills continuously at requestsPerSecond, up
 *   to burstCapacity. A request is admitted if at least one token is
 *   available, which is then spent. Because idle capacity accumulates,
 *   a burst arriving after a quiet period is admitted in full up to
 *   burstCapacity, then throttles down to the steady rate.
 * - Sliding Window: counts admissions in the trailing second and admits
 *   only while that count is under requestsPerSecond. No accumulation,
 *   no burst allowance — a hard, steady ceiling.
 *
 * Under smooth traffic at or under the configured rate, both admit
 * essentially everything — they only diverge once traffic bursts past
 * the steady rate, which is the actual lesson.
 *
 * Like LoadBalancer, this has no processing latency of its own — it's an
 * instant gate, not a queue — and it forwards the response leg back
 * through itself unconditionally (see responseRouting.ts) even though
 * neither algorithm needs to react to a response: anything sitting
 * behind it (a Cache) does, and skipping that leg would silently break it.
 *
 * Learning goal: rejecting immediately at a steady ceiling is a different
 * kind of protection than queueing or buffering — it trades "nothing
 * waits" for "nothing gets a chance to catch up," which only makes sense
 * when the caller can itself retry or degrade gracefully.
 */

import type { Entity, SimulationContext } from "./Entity";
import type { EntityId } from "../types";
import type {
  RequestLifecycleMetadata,
  SimulationEvent,
} from "../events/types";
import { findResponseTarget } from "./responseRouting";
import {
  createRateLimitAdmittedEvent,
  createRateLimitExceededEvent,
  createRequestCompletedEvent,
  createRequestFailedEvent,
  createRequestRoutedEvent,
} from "../events/EventFactory";

export type RateLimiterAlgorithm = "token_bucket" | "sliding_window";

export interface RateLimiterConfig {
  algorithm?: RateLimiterAlgorithm;
  requestsPerSecond?: number;
  /** Token Bucket only — how many requests can burst through at once once idle capacity has accumulated. */
  burstCapacity?: number;
}

const DEFAULTS: Required<RateLimiterConfig> = {
  algorithm: "token_bucket",
  requestsPerSecond: 50,
  burstCapacity: 100,
};

/** Sliding Window's trailing period — admissions older than this age out. */
const WINDOW_MS = 1000;

export class RateLimiter implements Entity {
  readonly id: EntityId;

  private readonly config: Required<RateLimiterConfig>;

  /** Token Bucket only. */
  private tokens: number;
  private lastRefillAt: number | null = null;

  /** Sliding Window only — admission timestamps within the trailing WINDOW_MS, oldest first. */
  private readonly admittedAt: number[] = [];

  constructor(id: EntityId, config: RateLimiterConfig = {}) {
    this.id = id;
    this.config = { ...DEFAULTS, ...config };
    this.tokens = this.config.burstCapacity;
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

    if (!this.tryAdmit(ctx.now)) {
      return [
        createRateLimitExceededEvent(ctx.now, this.id, event.requestId),
        ...this.fail(meta, ctx, event.requestId, "rate_limit_exceeded"),
      ];
    }

    const target = ctx.downstream[0];
    const latency = ctx.latencyTo(target);
    return [
      createRateLimitAdmittedEvent(ctx.now, this.id, event.requestId),
      createRequestRoutedEvent(ctx.now + latency, this.id, target, event.requestId, {
        ...meta,
        direction: "request",
        path: [...meta.path, this.id],
      }),
    ];
  }

  private tryAdmit(now: number): boolean {
    return this.config.algorithm === "token_bucket"
      ? this.tryAdmitTokenBucket(now)
      : this.tryAdmitSlidingWindow(now);
  }

  private tryAdmitTokenBucket(now: number): boolean {
    if (this.lastRefillAt !== null) {
      const elapsedMs = now - this.lastRefillAt;
      const refill = (elapsedMs / 1000) * this.config.requestsPerSecond;
      this.tokens = Math.min(this.config.burstCapacity, this.tokens + refill);
    }
    this.lastRefillAt = now;

    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  private tryAdmitSlidingWindow(now: number): boolean {
    while (
      this.admittedAt.length > 0 &&
      this.admittedAt[0] <= now - WINDOW_MS
    ) {
      this.admittedAt.shift();
    }
    if (this.admittedAt.length >= this.config.requestsPerSecond) return false;
    this.admittedAt.push(now);
    return true;
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
