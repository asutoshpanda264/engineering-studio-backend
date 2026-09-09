/**
 * The HumanInLoopGate is `docs/Agentic_AI.md` §2.1's approval-branch
 * primitive — "approval branch + latency injection before an irreversible
 * action." It's the mitigation §1.7's failure-mode table names for #6
 * (agent paralysis — "defined exit conditions + escalation path") and #10
 * (indirect prompt injection — "trust boundaries, human-in-loop before
 * irreversible actions"), and the lesson content written ahead of this
 * entity (`01-what-is-an-agent.ts`, `04-tool-use-and-the-tool-call-
 * boundary.ts`) already argues for it directly: "an irreversible action...
 * deserves a harder, explicit gate than a reversible one... reversibility-
 * weighted risk, not one uniform check for every tool" — the same
 * philosophy §1.9 documents Claude Code itself shipping.
 *
 * Structurally this is every other agentic entity's exact admit→queue→
 * reject shape (BoundedProcessor, forward downstream or respond, safe to
 * end a chain on) — a human review is bounded-capacity work too, a
 * reviewer can only look at so many requests at once. The one thing this
 * entity is actually *for* is Approval Latency: a deliberately large
 * processing time standing in for a real human's review delay, wired in
 * front of whatever `tool_call` actually performs the irreversible action.
 * Denial Rate then decides the outcome once that delay elapses — approved
 * requests forward on exactly like every other passing check; denied ones
 * fail with reason "human_denied_approval", a distinct, honest signal from
 * a guardrail rejection or a tool failure: a human looked at this and said
 * no.
 *
 * No new EventType, same reasoning GuardrailValidator.ts/Retriever.ts
 * document for their own mode distinctions: approve vs. deny already shows
 * up as the standard REQUEST_COMPLETED/REQUEST_FAILED split.
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

export interface HumanInLoopGateConfig {
  /** Approvals this node can be actively reviewing at once. */
  maxConcurrent?: number;
  /** Approvals allowed to wait once maxConcurrent is reached. */
  maxQueueLength?: number;
  /** The review delay itself, in ms — this entity's whole reason for existing: a real human doesn't decide instantly. */
  approvalLatencyMs?: number;
  /** Random +/- jitter applied to approvalLatencyMs, in ms. */
  approvalLatencyJitterMs?: number;
  /** Chance (0.0-1.0) a human reviewer denies the request once the review delay elapses. */
  denialRate?: number;
}

const DEFAULTS: Required<HumanInLoopGateConfig> = {
  maxConcurrent: 5,
  maxQueueLength: 30,
  approvalLatencyMs: 4000,
  approvalLatencyJitterMs: 1500,
  denialRate: 0.1,
};

export class HumanInLoopGate implements Entity {
  readonly id: EntityId;

  private readonly config: Required<HumanInLoopGateConfig>;
  private readonly processor: BoundedProcessor;
  private readonly inFlight = new Map<RequestId, RequestLifecycleMetadata>();

  constructor(id: EntityId, config: HumanInLoopGateConfig = {}) {
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
      -this.config.approvalLatencyJitterMs,
      this.config.approvalLatencyJitterMs + 1
    );
    const duration = Math.max(1, this.config.approvalLatencyMs + jitter);

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

    if (ctx.rng.next() < this.config.denialRate) {
      events.push(...this.fail(meta, ctx, event.requestId, "human_denied_approval"));
      return events;
    }

    if (meta.direction === "request") {
      const target = ctx.downstream[0];
      if (!target) {
        // Nothing wired downstream — safe to end a chain on, same
        // reasoning every other entity's no-downstream case documents.
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

  /** See APIServer.ts's identically-shaped helper. */
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

  /** See Database.ts/APIServer.ts's identical helper. */
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
