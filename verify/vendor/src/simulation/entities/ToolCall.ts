/**
 * The ToolCall is the external-action primitive from `docs/Agentic_AI.md`
 * §2.1 — a `tool_call` node maps to an `execute_tool` span in that doc's
 * tracing vocabulary (§1.6/§2.4, not yet implemented). Tool Use, the
 * simplest of the six canonical patterns, is exactly `llm_call` →
 * `tool_call` (see LlmCall.ts's class doc) — this entity is the "→" turns
 * into on canvas.
 *
 * Structurally this is APIServer.ts's exact shape (bounded concurrency via
 * BoundedProcessor, admit → queue → reject, forward downstream if
 * something is wired past it or respond otherwise, safe to end a chain
 * on) — a tool call doing bounded external work earns the identical
 * admission/queueing mechanism every other bounded-capacity entity in
 * this engine uses, not a bespoke one. Forwarding downstream (rather than
 * always terminating, the way Database.ts does) is deliberate: a real
 * tool call can itself reach further infrastructure — an internal
 * microservice, another tool — so this stays wireable onward, same as
 * APIServer.
 *
 * Two independent failure rolls at the end of every processing step,
 * covering the two `docs/Agentic_AI.md` §1.7 failure modes that live at
 * the tool-call boundary specifically (as opposed to `hallucinationRate`,
 * which belongs to the *calling* `llm_call` — a tool doesn't hallucinate,
 * the model calling it does):
 *
 * - `schemaFailureRate` — failure mode #1, schema violation: the tool's
 *   own response doesn't match the shape the caller expected.
 * - `failureRate` — a stand-in for the external call simply failing or
 *   coming back unavailable/malformed outright, an explicit REQUEST_FAILED.
 *
 * Two more dials, both from Phase 4's failure catalog (§2.3), rolled at
 * the same point but with genuinely different shapes from the two above:
 *
 * - `hallucinatedInvocationRate` — failure mode #2: the *calling* model
 *   invented a tool that was never really registered/reachable. Checked
 *   before every other roll, since a hallucinated invocation never
 *   legitimately reached a real external system at all — there's no
 *   "schema" or "call" to fail, just a call that should never have been
 *   dispatched. An explicit REQUEST_FAILED with reason
 *   "hallucinated_tool_call", distinct from `schemaFailureRate`'s
 *   "schema_violation" and `failureRate`'s "tool_call_failed" — the same
 *   "pre-dispatch validation" mitigation §1.7's table names is exactly
 *   what would have caught this one before it ever reached here.
 * - `silentFailureRate` — the *real* failure mode #4, "returns 200 with an
 *   empty/malformed payload, no error surfaces" — properly modeled now,
 *   as opposed to `failureRate`'s explicit "the call failed": rolled only
 *   on the success path, it stamps the outgoing metadata
 *   `compromised: true, compromiseReason: "silent_tool_failure"` instead
 *   of failing outright. Nothing downstream notices unless a
 *   `guardrail_validator`'s `compromiseCatchRate` is wired in to actually
 *   check for it — see `RequestLifecycleMetadata.compromised`'s own doc.
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

export interface ToolCallConfig {
  /** External calls this node can have in flight at once. */
  maxConcurrent?: number;
  /** Calls allowed to wait once maxConcurrent is reached. */
  maxQueueLength?: number;
  /** Base time for the external call to complete, in ms. */
  processingTimeMs?: number;
  /** Random +/- jitter applied to processingTimeMs, in ms. */
  processingJitterMs?: number;
  /** Chance (0.0-1.0) the external call itself fails or comes back unavailable. */
  failureRate?: number;
  /** Chance (0.0-1.0) the tool's response doesn't match the caller's expected schema. */
  schemaFailureRate?: number;
  /** Chance (0.0-1.0) this call never should have happened — the calling model invented a tool that was never registered. Failure mode #2. */
  hallucinatedInvocationRate?: number;
  /** Chance (0.0-1.0) a successful call quietly comes back empty/malformed instead of failing outright. Failure mode #4 — see class doc. Not a failure by itself. */
  silentFailureRate?: number;
}

const DEFAULTS: Required<ToolCallConfig> = {
  maxConcurrent: 15,
  maxQueueLength: 100,
  processingTimeMs: 120,
  processingJitterMs: 40,
  failureRate: 0.02,
  schemaFailureRate: 0.02,
  hallucinatedInvocationRate: 0.02,
  silentFailureRate: 0.03,
};

export class ToolCall implements Entity {
  readonly id: EntityId;

  private readonly config: Required<ToolCallConfig>;
  private readonly processor: BoundedProcessor;
  private readonly inFlight = new Map<RequestId, RequestLifecycleMetadata>();

  constructor(id: EntityId, config: ToolCallConfig = {}) {
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

    // Hallucinated invocation checked first — a call that never should
    // have been dispatched never gets far enough to have a schema or a
    // generic failure at all. See class doc, failure mode #2.
    if (ctx.rng.next() < this.config.hallucinatedInvocationRate) {
      events.push(...this.fail(meta, ctx, event.requestId, "hallucinated_tool_call"));
      return events;
    }
    // Schema violation checked before a generic call failure — a
    // malformed response is a distinct, more specific signal than "the
    // call failed outright," same ordering LlmCall.ts uses.
    if (ctx.rng.next() < this.config.schemaFailureRate) {
      events.push(...this.fail(meta, ctx, event.requestId, "schema_violation"));
      return events;
    }
    if (ctx.rng.next() < this.config.failureRate) {
      events.push(...this.fail(meta, ctx, event.requestId, "tool_call_failed"));
      return events;
    }

    // Silent failure (#4) — a "succeeds anyway" compromise, not a failure.
    // Only rolled if nothing upstream already compromised this request,
    // same "first compromise wins" simplicity every compromise roll here
    // follows.
    const outgoingMeta: RequestLifecycleMetadata =
      !meta.compromised && ctx.rng.next() < this.config.silentFailureRate
        ? { ...meta, compromised: true, compromiseReason: "silent_tool_failure" }
        : meta;

    if (outgoingMeta.direction === "request") {
      const target = ctx.downstream[0];
      if (!target) {
        // Nothing wired downstream — this tool call is the end of the
        // chain, same "safe to end on" reasoning APIServer.ts documents.
        events.push(...this.respond(outgoingMeta, ctx, event.requestId));
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
            ...outgoingMeta,
            direction: "request",
            path: [...outgoingMeta.path, this.id],
          }
        )
      );
    } else {
      events.push(...this.respond(outgoingMeta, ctx, event.requestId));
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
