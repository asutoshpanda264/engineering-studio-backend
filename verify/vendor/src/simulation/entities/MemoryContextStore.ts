/**
 * MemoryContextStore models the context window an agent's short-term
 * memory lives in — `docs/Agentic_AI.md` §1.4/§2.2's second policy-bearing
 * primitive (`retriever` is the third, landing separately). Context
 * engineering's four pillars are instructions/retrieval/memory/tools;
 * this entity is specifically the memory pillar's short-term half — the
 * conversation + tool history living in the context window, and what
 * happens once it fills up.
 *
 * Every request the traffic generator sends through this node is modeled
 * as one more turn in a single, long-running agent session this node
 * maintains for the whole simulation run — a deliberate simplification:
 * this engine's traffic model is many independent requests, not one
 * literal multi-turn conversation, so "the session" is represented as
 * this node's own persistent running state (`contextSizeTokens`,
 * `criticalInfoIntact`, `compactionCount`), evolving turn over turn the
 * same way Cache's CacheStore holds entries across requests rather than
 * per-request — not a bespoke shape, the established one applied to a new
 * kind of running state.
 *
 * Three selectable compaction policies (§2.2's comparison-panel
 * requirement — "same long session, three compaction policies, watch
 * when/whether attention-relevant info survives to the final turn"; same
 * "ship multiple comparable options, not one hardcoded default"
 * precedent Cache's eviction policies and stampede modes already set):
 *
 * - `none` — truncate oldest: once `contextSizeTokens` exceeds
 *   `capacityTokens`, clamp straight back down to `capacityTokens` (drop
 *   whatever's oldest), free and instant. The FIRST time this happens,
 *   the assumed-early "critical info" (the original task/constraint,
 *   the thing truncation always evicts first in a real transcript) is
 *   gone for good — `criticalInfoIntact` flips false and never recovers.
 *   The deliberate "watch context rot happen" option §2.2 calls for.
 * - `summarization` — compress instead of drop: `contextSizeTokens` falls
 *   to a fraction of capacity (a summary, not the raw history), at the
 *   cost of `summarizationOverheadMs` extra latency on the compacting
 *   turn. Critical info mostly survives each pass but isn't guaranteed —
 *   `summarizationInfoLossRate` is rolled independently on every
 *   compaction, so it can still happen, just far less certainly than
 *   `none`.
 * - `scratchpad` — Anthropic's own documented pattern: overflow is
 *   written to a file outside the context window instead of being
 *   summarized or dropped. `contextSizeTokens` falls to a small active
 *   window and `scratchpadInfoLossRate` is near-zero (a scratchpad write
 *   can still occasionally fail, so this isn't literally 100% either) —
 *   but once the file exists, EVERY subsequent turn pays
 *   `scratchpadReadLatencyMs` to re-read it back, a real, sustained cost
 *   the other two policies don't carry.
 *
 * Once `criticalInfoIntact` is false, every turn independently rolls
 * `driftFailureRate` and can fail with reason "context_truncation" —
 * `docs/Agentic_AI.md` §2.3's failure mode #3, made observable rather
 * than asserted, the same "both directions" independent-roll spirit
 * LlmCall.ts documents for its own failure checks.
 *
 * Emits a self-addressed CONTEXT_COMPACTED marker (destination null, same
 * pattern as CACHE_HIT/MISS and CIRCUIT_OPENED/CLOSED) only on turns that
 * actually trigger compaction — MetricsCollector derives compaction count
 * and current `criticalInfoIntact` from these, "last one wins", the same
 * way circuit breaker state is derived.
 *
 * Structurally still APIServer.ts's bounded admit→queue→reject shape;
 * only the per-turn running-context bookkeeping above is new.
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
  createContextCompactionEvent,
  createProcessingCompletedEvent,
  createProcessingStartedEvent,
  createQueueFullEvent,
  createRequestCompletedEvent,
  createRequestDequeuedEvent,
  createRequestFailedEvent,
  createRequestQueuedEvent,
  createRequestRoutedEvent,
} from "../events/EventFactory";

export type CompactionPolicy = "none" | "summarization" | "scratchpad";

export interface MemoryContextStoreConfig {
  /** Turns this node can be actively handling at once. */
  maxConcurrent?: number;
  /** Turns allowed to wait once maxConcurrent is reached. */
  maxQueueLength?: number;
  /** Base per-turn bookkeeping time, in ms, before any compaction-specific overhead. */
  processingTimeMs?: number;
  /** Random +/- jitter applied to processingTimeMs, in ms. */
  processingJitterMs?: number;
  /** How this node behaves once the context window fills — the policy-bearing dial. */
  compactionPolicy?: CompactionPolicy;
  /** Size of the context window, in tokens. */
  capacityTokens?: number;
  /** How many tokens each turn adds to the running context size. */
  tokensPerTurn?: number;
  /** Extra latency, in ms, on a turn that triggers a summarization pass. Only meaningful under "summarization". */
  summarizationOverheadMs?: number;
  /** Chance (0.0-1.0) a summarization pass loses the critical info anyway. Only meaningful under "summarization". */
  summarizationInfoLossRate?: number;
  /** Extra latency, in ms, on every turn after the scratchpad file exists. Only meaningful under "scratchpad". */
  scratchpadReadLatencyMs?: number;
  /** Chance (0.0-1.0) a scratchpad write itself loses the critical info. Only meaningful under "scratchpad". */
  scratchpadInfoLossRate?: number;
  /** Chance (0.0-1.0), rolled independently every turn once critical info is gone, that this turn fails with "context_truncation". */
  driftFailureRate?: number;
}

const DEFAULTS: Required<MemoryContextStoreConfig> = {
  maxConcurrent: 20,
  maxQueueLength: 100,
  processingTimeMs: 10,
  processingJitterMs: 5,
  compactionPolicy: "none",
  capacityTokens: 8000,
  tokensPerTurn: 500,
  summarizationOverheadMs: 150,
  summarizationInfoLossRate: 0.1,
  scratchpadReadLatencyMs: 80,
  scratchpadInfoLossRate: 0.01,
  driftFailureRate: 0.3,
};

/** Illustrative, directional multipliers — same "not measured, not asserted" spirit LlmCall.ts's TIER_PROFILE/QUANTIZATION_PROFILE tables document. */
const SUMMARIZATION_RATIO = 0.4;
const SCRATCHPAD_ACTIVE_WINDOW_RATIO = 0.3;

export class MemoryContextStore implements Entity {
  readonly id: EntityId;

  private readonly config: Required<MemoryContextStoreConfig>;
  private readonly processor: BoundedProcessor;
  private readonly inFlight = new Map<RequestId, RequestLifecycleMetadata>();

  // Running session state — persists across every turn this node ever
  // handles for the whole simulation run, not per-request. See class doc.
  private contextSizeTokens = 0;
  private criticalInfoIntact = true;
  private compactionCount = 0;
  private hasScratchpadFile = false;

  constructor(id: EntityId, config: MemoryContextStoreConfig = {}) {
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

    // This turn's contribution to the running session.
    this.contextSizeTokens += this.config.tokensPerTurn;

    let compactionOverheadMs = 0;
    const events: SimulationEvent[] = [];

    if (this.contextSizeTokens > this.config.capacityTokens) {
      compactionOverheadMs = this.compact(requestId, ctx, events);
    } else if (
      this.config.compactionPolicy === "scratchpad" &&
      this.hasScratchpadFile
    ) {
      // Every turn after the file exists pays a re-read cost, not just
      // compacting turns — the scratchpad's real, sustained trade-off.
      compactionOverheadMs = this.config.scratchpadReadLatencyMs;
    }

    const jitter = ctx.rng.nextInt(
      -this.config.processingJitterMs,
      this.config.processingJitterMs + 1
    );
    const duration = Math.max(
      1,
      this.config.processingTimeMs + jitter + compactionOverheadMs
    );

    events.push(
      createProcessingStartedEvent(ctx.now, this.id, requestId),
      createProcessingCompletedEvent(ctx.now + duration, this.id, requestId)
    );
    return events;
  }

  /** Applies this node's compactionPolicy, mutates running state, and returns any extra latency (ms) this turn should pay. */
  private compact(
    requestId: RequestId,
    ctx: SimulationContext,
    events: SimulationEvent[]
  ): number {
    this.compactionCount++;
    let overheadMs = 0;

    switch (this.config.compactionPolicy) {
      case "none": {
        this.contextSizeTokens = this.config.capacityTokens;
        if (this.compactionCount === 1) {
          // Truncation always drops the oldest content first — the
          // original task/constraint, gone for good.
          this.criticalInfoIntact = false;
        }
        break;
      }
      case "summarization": {
        this.contextSizeTokens = Math.round(
          this.config.capacityTokens * SUMMARIZATION_RATIO
        );
        overheadMs = this.config.summarizationOverheadMs;
        if (
          this.criticalInfoIntact &&
          ctx.rng.next() < this.config.summarizationInfoLossRate
        ) {
          this.criticalInfoIntact = false;
        }
        break;
      }
      case "scratchpad": {
        this.contextSizeTokens = Math.round(
          this.config.capacityTokens * SCRATCHPAD_ACTIVE_WINDOW_RATIO
        );
        this.hasScratchpadFile = true;
        overheadMs = this.config.scratchpadReadLatencyMs;
        if (
          this.criticalInfoIntact &&
          ctx.rng.next() < this.config.scratchpadInfoLossRate
        ) {
          this.criticalInfoIntact = false;
        }
        break;
      }
    }

    events.push(
      createContextCompactionEvent(
        ctx.now,
        this.id,
        requestId,
        this.config.compactionPolicy,
        this.contextSizeTokens,
        this.criticalInfoIntact
      )
    );
    return overheadMs;
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

    // The observable consequence of lost critical info — failure mode
    // #3, made visible rather than asserted, once it's actually gone.
    if (
      !this.criticalInfoIntact &&
      ctx.rng.next() < this.config.driftFailureRate
    ) {
      events.push(...this.fail(meta, ctx, event.requestId, "context_truncation"));
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
