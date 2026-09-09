/**
 * Retriever models the knowledge-lookup step in `docs/Agentic_AI.md`
 * §1.5/§2.2 — the third policy-bearing primitive (`llm_call` and
 * `memory_context_store` are the first two). RAG fractured into three
 * real architectures that only pretend to be one thing, plus a fourth
 * that routes between them — four selectable `mode`s, same "ship
 * multiple comparable options, not one hardcoded default" precedent
 * every other policy-bearing entity here follows:
 *
 * - `pipeline` — the 2023-era baseline: embed → top-k → generate, one
 *   shot, no self-correction. Fast and cheap; `missRate` is the chance a
 *   single retrieval attempt doesn't actually surface what answers the
 *   query.
 * - `agentic` — turns retrieval into a bounded loop: retrieve, (implicit)
 *   critique, re-retrieve, up to `maxRetrievalAttempts` times, paying
 *   `critiqueOverheadMs` on every attempt. The real, documented risk
 *   §1.5 names isn't modeled as a free improvement: if it exhausts its
 *   budget without ever resolving, the final answer is more likely to be
 *   *confidently* wrong (`retrieval_hallucination`) than a plain miss —
 *   "without redundancy this self-corrects into a more elaborate
 *   hallucination," not just "eventually gives up honestly."
 * - `graphrag` — extracts entities/relationships into a graph and
 *   retrieves via traversal instead of chunk similarity. Slower and a
 *   little less reliable than Pipeline on ordinary queries (traversal
 *   isn't free even for a simple lookup — no strictly-dominant choice
 *   here either), but wins decisively on the specific traffic chunk
 *   similarity structurally cannot answer — see
 *   `requiresRelationshipTraversal` below.
 * - `adaptive` — a query-complexity classifier routes each query to the
 *   cheapest pipeline that can answer it. Modeled directly rather than
 *   approximated: an Adaptive node reuses Pipeline's own behavior for an
 *   ordinary query and GraphRAG's own behavior for a relationship query
 *   (plus a small `classifierOverheadMs` for the routing decision
 *   itself), rather than inventing a fifth set of numbers.
 *
 * `requiresRelationshipTraversal` (RequestLifecycleMetadata, decided once
 * at the Client from its Relationship Query Rate config, same shape as
 * `exists`/Missing Key Rate) is what makes GraphRAG's advantage — and
 * Pipeline/Agentic's structural weakness on the identical traffic —
 * something you measure by running it, not something a lesson asserts:
 * `relationshipPenaltyMultiplier` makes chunk-based retrieval meaningfully
 * worse on this traffic; `graphRelationshipBonusMultiplier` makes GraphRAG
 * meaningfully better on it.
 *
 * All four modes' outcomes (attempts used, final miss/hallucination) are
 * resolved synchronously in `beginProcessing`, before the corresponding
 * PROCESSING_COMPLETED is even scheduled — Agentic's total duration
 * depends on how many attempts its own random rolls end up taking, so the
 * duration and the outcome have to be computed together up front, then
 * simply acted on once the wait elapses. This is a legitimate variation
 * on the roll-at-completion shape most other entities use, not a
 * determinism risk: the RNG is one deterministic sequence regardless of
 * which handler consumes it, as long as it's always consumed in the same
 * event order — which the discrete-event queue already guarantees.
 *
 * Structurally still the bounded admit→queue→reject shape every other
 * entity here uses; only the per-mode outcome computation above is new.
 * No new EventType: unlike MemoryContextStore, every metric a comparison
 * panel needs (success rate, average latency, cost) is already derivable
 * from the standard REQUEST_COMPLETED/REQUEST_FAILED events plus
 * `costEngine.ts`'s own per-mode pricing — see that file's
 * `retrieverPricing`.
 *
 * `poisonedContentRate` is Phase 4's failure mode #10, indirect prompt
 * injection: rolled only when a mode's own outcome resolves successfully
 * (a miss/hallucination has nothing to poison), it stamps the outgoing
 * metadata `compromised: true, compromiseReason: "indirect_prompt_
 * injection"` instead of failing — malicious instructions embedded in
 * retrieved content, reaching the downstream `llm_call` looking like a
 * perfectly normal, successful retrieval. Only a `guardrail_validator`
 * wired between this node and that `llm_call` (its own
 * `compromiseCatchRate`) has any chance of catching it first — the exact
 * topology §2.3 names.
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

export type RetrieverMode = "pipeline" | "agentic" | "graphrag" | "adaptive";

export interface RetrieverConfig {
  /** Retrievals this node can be actively running at once. */
  maxConcurrent?: number;
  /** Retrievals allowed to wait once maxConcurrent is reached. */
  maxQueueLength?: number;
  /** Which retrieval architecture this node runs — the policy-bearing dial. */
  mode?: RetrieverMode;
  /** Base per-attempt retrieval time, in ms — used by pipeline, every agentic attempt, and adaptive's non-relationship path. */
  processingTimeMs?: number;
  /** Random +/- jitter applied to every timed component, in ms. */
  processingJitterMs?: number;
  /** Chance (0.0-1.0) a single chunk-similarity retrieval attempt fails to surface what answers the query. */
  missRate?: number;
  /** Multiplies missRate when the request needs relationship reasoning — chunk similarity structurally struggles here. */
  relationshipPenaltyMultiplier?: number;
  /** Total retrieve-critique-reretrieve attempts allowed before giving up. Agentic only. */
  maxRetrievalAttempts?: number;
  /** Extra latency, in ms, on every agentic attempt for the critique/self-assessment step. Agentic only. */
  critiqueOverheadMs?: number;
  /** Chance (0.0-1.0) that exhausting the attempt budget without resolving produces a confidently-wrong answer rather than a plain miss. Agentic only. */
  unresolvedHallucinationRate?: number;
  /** Base graph-traversal time, in ms — replaces processingTimeMs under graphrag and adaptive's relationship path. */
  graphTraversalTimeMs?: number;
  /** GraphRAG's own miss rate on ordinary (non-relationship) queries — traversal isn't free even for a simple lookup. */
  graphMissRateBase?: number;
  /** Multiplies graphMissRateBase down when the request needs relationship reasoning — GraphRAG's whole reason for existing. */
  graphRelationshipBonusMultiplier?: number;
  /** Extra latency, in ms, for the complexity-classification step itself. Adaptive only. */
  classifierOverheadMs?: number;
  /** Base cost per query, in USD — scaled per mode in costEngine.ts's retrieverPricing, not here. */
  costPerQueryUsd?: number;
  /** Chance (0.0-1.0) a successfully resolved retrieval's content is actually poisoned. Failure mode #10, indirect prompt injection. Not a failure; see class doc. */
  poisonedContentRate?: number;
}

const DEFAULTS: Required<RetrieverConfig> = {
  maxConcurrent: 30,
  maxQueueLength: 150,
  mode: "pipeline",
  processingTimeMs: 80,
  processingJitterMs: 30,
  missRate: 0.12,
  relationshipPenaltyMultiplier: 4,
  maxRetrievalAttempts: 3,
  critiqueOverheadMs: 60,
  unresolvedHallucinationRate: 0.4,
  graphTraversalTimeMs: 180,
  graphMissRateBase: 0.18,
  graphRelationshipBonusMultiplier: 0.1,
  classifierOverheadMs: 15,
  costPerQueryUsd: 0.002,
  poisonedContentRate: 0.02,
};

interface InFlightEntry {
  /** Already stamped with `compromised`/`compromiseReason` if poisonedContentRate triggered — see beginProcessing. */
  meta: RequestLifecycleMetadata;
  failureReason: string | null;
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

export class Retriever implements Entity {
  readonly id: EntityId;

  private readonly config: Required<RetrieverConfig>;
  private readonly processor: BoundedProcessor;
  private readonly inFlight = new Map<RequestId, InFlightEntry>();

  constructor(id: EntityId, config: RetrieverConfig = {}) {
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

  /** Resolves this mode's outcome (attempts used, final success/failure) and schedules a single PROCESSING_COMPLETED for the total duration. See class doc. */
  private beginProcessing(
    requestId: RequestId,
    meta: RequestLifecycleMetadata,
    ctx: SimulationContext
  ): SimulationEvent[] {
    const relationshipQuery = meta.requiresRelationshipTraversal === true;
    const jitter = (): number =>
      ctx.rng.nextInt(-this.config.processingJitterMs, this.config.processingJitterMs + 1);

    let durationMs = 0;
    let failureReason: string | null = null;

    switch (this.config.mode) {
      case "pipeline": {
        durationMs = Math.max(1, this.config.processingTimeMs + jitter());
        const effectiveMissRate = clamp01(
          this.config.missRate *
            (relationshipQuery ? this.config.relationshipPenaltyMultiplier : 1)
        );
        if (ctx.rng.next() < effectiveMissRate) failureReason = "retrieval_miss";
        break;
      }
      case "graphrag": {
        durationMs = Math.max(1, this.config.graphTraversalTimeMs + jitter());
        const effectiveMissRate = clamp01(
          relationshipQuery
            ? this.config.graphMissRateBase * this.config.graphRelationshipBonusMultiplier
            : this.config.graphMissRateBase
        );
        if (ctx.rng.next() < effectiveMissRate) failureReason = "retrieval_miss";
        break;
      }
      case "adaptive": {
        if (relationshipQuery) {
          durationMs = Math.max(
            1,
            this.config.graphTraversalTimeMs + jitter() + this.config.classifierOverheadMs
          );
          const effectiveMissRate = clamp01(
            this.config.graphMissRateBase * this.config.graphRelationshipBonusMultiplier
          );
          if (ctx.rng.next() < effectiveMissRate) failureReason = "retrieval_miss";
        } else {
          durationMs = Math.max(
            1,
            this.config.processingTimeMs + jitter() + this.config.classifierOverheadMs
          );
          if (ctx.rng.next() < clamp01(this.config.missRate)) failureReason = "retrieval_miss";
        }
        break;
      }
      case "agentic": {
        const effectiveMissRate = clamp01(
          this.config.missRate *
            (relationshipQuery ? this.config.relationshipPenaltyMultiplier : 1)
        );
        let resolved = false;
        for (let attempt = 1; attempt <= this.config.maxRetrievalAttempts; attempt++) {
          durationMs += Math.max(
            1,
            this.config.processingTimeMs + jitter() + this.config.critiqueOverheadMs
          );
          if (ctx.rng.next() >= effectiveMissRate) {
            resolved = true;
            break;
          }
        }
        if (!resolved) {
          failureReason =
            ctx.rng.next() < this.config.unresolvedHallucinationRate
              ? "retrieval_hallucination"
              : "retrieval_miss";
        }
        break;
      }
    }

    // Failure mode #10 (indirect prompt injection) — only meaningful when
    // this attempt actually resolved; a miss/hallucination has no content
    // to poison. "First compromise wins," same simplicity every other
    // compromise roll in this engine follows.
    const outgoingMeta: RequestLifecycleMetadata =
      !failureReason && !meta.compromised && ctx.rng.next() < this.config.poisonedContentRate
        ? { ...meta, compromised: true, compromiseReason: "indirect_prompt_injection" }
        : meta;

    this.inFlight.set(requestId, { meta: outgoingMeta, failureReason });
    return [
      createProcessingStartedEvent(ctx.now, this.id, requestId),
      createProcessingCompletedEvent(ctx.now + durationMs, this.id, requestId),
    ];
  }

  private onProcessingComplete(
    event: SimulationEvent,
    ctx: SimulationContext
  ): SimulationEvent[] {
    if (!event.requestId) return [];
    const entry = this.inFlight.get(event.requestId);
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

    if (!entry) return events;
    const { meta, failureReason } = entry;

    if (failureReason) {
      events.push(...this.fail(meta, ctx, event.requestId, failureReason));
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
