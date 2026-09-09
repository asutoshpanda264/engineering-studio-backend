/**
 * The APIServer processes business logic between the Client and Database.
 *
 * ENTITIES.md doesn't document this entity in detail (only Client is
 * fully written up) — this behavior is designed to fit the same
 * five-question framework (what am I / what do I know / what can happen
 * to me / what can I do / what should users learn), using the config
 * fields TECHNICAL-SPECIFICATION.md's "Entity Configuration" section
 * sketches for infrastructure entities generally.
 *
 * Every unit of work — the inbound request AND the database's returning
 * response — goes through the same bounded concurrency/queue admission
 * (BoundedProcessor), since both represent "the API doing work" and both
 * should be subject to the same capacity limit. `direction` on the
 * request's metadata decides what happens once processing finishes:
 * forward deeper (request) or reply to the client (response).
 *
 * Learning goal: a server has finite capacity — beyond it, requests wait
 * in a bounded queue or are rejected outright. That's backpressure.
 */

import type { Entity, SimulationContext } from "./Entity";
import type { EntityId, RequestId } from "../types";
import type {
  RequestLifecycleMetadata,
  SimulationEvent,
} from "../events/types";
import { BoundedProcessor } from "./BoundedProcessor";
import { findResponseTarget } from "./responseRouting";
import {
  createProcessingCompletedEvent,
  createProcessingStartedEvent,
  createQueueFullEvent,
  createRequestCompletedEvent,
  createRequestDequeuedEvent,
  createRequestFailedEvent,
  createRequestQueuedEvent,
  createRequestRoutedEvent,
} from "../events/EventFactory";

export interface APIServerConfig {
  /** Requests this server can be actively processing at once. */
  maxConcurrent?: number;
  /** Requests allowed to wait once maxConcurrent is reached. */
  maxQueueLength?: number;
  /** Base time to process a request or generate a response, in ms. */
  processingTimeMs?: number;
  /** Random +/- jitter applied to processingTimeMs, in ms. */
  processingJitterMs?: number;
}

const DEFAULTS: Required<APIServerConfig> = {
  maxConcurrent: 10,
  maxQueueLength: 50,
  processingTimeMs: 5,
  processingJitterMs: 2,
};

export class APIServer implements Entity {
  readonly id: EntityId;

  private readonly config: Required<APIServerConfig>;
  private readonly processor: BoundedProcessor;
  /** Info needed to resume once the in-flight request's processing completes. */
  private readonly inFlight = new Map<RequestId, RequestLifecycleMetadata>();

  constructor(id: EntityId, config: APIServerConfig = {}) {
    this.id = id;
    this.config = { ...DEFAULTS, ...config };
    this.processor = new BoundedProcessor(
      this.config.maxConcurrent,
      this.config.maxQueueLength
    );
  }

  handleEvent(
    event: SimulationEvent,
    ctx: SimulationContext
  ): SimulationEvent[] {
    if (event.type === "REQUEST_ROUTED" && event.destination === this.id) {
      return this.onArrival(event, ctx);
    }
    if (event.type === "PROCESSING_COMPLETED" && event.destination === this.id) {
      return this.onProcessingComplete(event, ctx);
    }
    return [];
  }

  private onArrival(
    event: SimulationEvent,
    ctx: SimulationContext
  ): SimulationEvent[] {
    if (!event.requestId) return [];
    const meta = event.metadata as RequestLifecycleMetadata;

    const result = this.processor.admit(event);
    if (result === "rejected") {
      return [
        createQueueFullEvent(ctx.now, this.id, event.requestId),
        ...this.fail(meta, ctx, event.requestId, "capacity_exceeded"),
      ];
    }
    if (result === "queued") {
      return [createRequestQueuedEvent(ctx.now, this.id, event.requestId)];
    }
    return this.beginProcessing(event.requestId, meta, ctx);
  }

  private beginProcessing(
    requestId: RequestId,
    meta: RequestLifecycleMetadata,
    ctx: SimulationContext
  ): SimulationEvent[] {
    this.inFlight.set(requestId, meta);
    const jitter = ctx.rng.nextInt(
      -this.config.processingJitterMs,
      this.config.processingJitterMs + 1
    );
    const duration = Math.max(1, this.config.processingTimeMs + jitter);

    return [
      createProcessingStartedEvent(ctx.now, this.id, requestId),
      createProcessingCompletedEvent(ctx.now + duration, this.id, requestId),
    ];
  }

  private onProcessingComplete(
    event: SimulationEvent,
    ctx: SimulationContext
  ): SimulationEvent[] {
    if (!event.requestId) return [];
    const meta = this.inFlight.get(event.requestId);
    this.inFlight.delete(event.requestId);

    const events: SimulationEvent[] = [];

    const nextQueued = this.processor.complete();
    if (nextQueued && nextQueued.requestId) {
      events.push(createRequestDequeuedEvent(ctx.now, this.id, nextQueued.requestId));
      events.push(
        ...this.beginProcessing(
          nextQueued.requestId,
          nextQueued.metadata as RequestLifecycleMetadata,
          ctx
        )
      );
    }

    if (!meta) return events;

    if (meta.direction === "request") {
      const target = ctx.downstream[0];
      if (!target) {
        // Nothing wired downstream (no Database) — this server has no
        // further call to make, so processing this request WAS the whole
        // job. Answer directly instead of failing: API Server is
        // documented as safe to end a chain on (its own recipe is the
        // bare `[client, api]` — see TUTORIAL-ENTITIES.md §1b), and every
        // recipe that routes *through* an API Server on its way to a
        // terminal node of its own (Load Balancer, CDN, Rate Limiter,
        // Reverse Proxy all end their recipe on `api`) depends on that
        // being true. Mirrors Cache.ts's "answered from local state" case
        // — it never appends itself to `path` either, since there's
        // nothing further to reach.
        events.push(...this.respond(meta, ctx, event.requestId));
        return events;
      }
      const latency = ctx.latencyTo(target);
      events.push(
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
        )
      );
    } else {
      events.push(...this.respond(meta, ctx, event.requestId));
    }

    return events;
  }

  /**
   * Replies to whoever should hear about this request finishing — the
   * Client directly, if this server is the last hop on the way back, or
   * one hop further up the chain otherwise. Shared by the real response
   * leg (a downstream Database answered) and the no-downstream terminal
   * case above, since both amount to "this server is done, someone needs
   * to hear about it" — see Database.ts/Cache.ts's identically-shaped
   * helper.
   */
  private respond(
    meta: RequestLifecycleMetadata,
    ctx: SimulationContext,
    requestId: RequestId
  ): SimulationEvent[] {
    const { target, isClient } = findResponseTarget(this.id, meta.path);
    if (isClient) {
      const duration = ctx.now - meta.startedAt;
      return [
        meta.failed
          ? createRequestFailedEvent(
              ctx.now,
              this.id,
              target,
              requestId,
              meta.failureReason ?? "unknown",
              { startedAt: meta.startedAt }
            )
          : createRequestCompletedEvent(
              ctx.now,
              this.id,
              target,
              requestId,
              duration
            ),
      ];
    }
    const latency = ctx.latencyTo(target);
    return [
      createRequestRoutedEvent(ctx.now + latency, this.id, target, requestId, {
        ...meta,
        direction: "response",
        path: meta.path,
      }),
    ];
  }

  /** See Database.ts's identical helper — routes a local failure via findResponseTarget instead of straight to the client. */
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
