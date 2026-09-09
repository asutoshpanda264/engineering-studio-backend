/**
 * The LlmCall is the reasoning/generation primitive every agent pattern in
 * `docs/Agentic_AI.md` §2.1 is built from — an `llm_call` node maps to a
 * `gen_ai chat` span in that doc's tracing vocabulary (§1.6/§2.4, not yet
 * implemented). Structurally this is APIServer.ts's exact shape (bounded
 * concurrency via BoundedProcessor, admit → queue → reject, forward
 * downstream on the request leg or respond on the response leg, safe to
 * end a chain on) — an LLM call and a business-logic handler are both "the
 * API doing bounded work," so they earn the identical admission/queueing
 * mechanism rather than a bespoke one. That reuse is deliberate, per
 * §1.12/§2.6: latency is a function of concurrent load using the engine's
 * existing admit-queue-reject shape, not new queueing logic.
 *
 * Three additional dials beyond APIServer's, all from §2.7 (`llm_call`
 * as this domain's third policy-bearing entity):
 *
 * - `tier` (SLM vs LLM) and `quantization` (None/FP8/INT8/INT4) each
 *   apply an independent latency multiplier AND an independent
 *   hallucination-rate multiplier — cheaper/faster options are also
 *   modeled as measurably less reliable (§1.10's "90% of functionality at
 *   10% of the cost", §1.11's "accuracy-risk up" as quantization
 *   increases), not a free win.
 * - `deploymentTarget` (Cloud vs Edge) adds/removes a network round-trip
 *   latency term (§1.10's sub-20ms-edge vs 200-500ms-cloud-round-trip
 *   contrast). Rather than disabling the LLM tier under Edge outright
 *   (§2.7's literal wording), this simulates the real, honest consequence
 *   of that combination instead of asserting a rule: Edge + LLM applies a
 *   heavy extra latency penalty (an oversized model straining constrained
 *   edge hardware) so the user discovers *why* that pairing is a bad idea
 *   by running it, the same "nothing is asserted, everything is
 *   simulated" philosophy every other entity in this engine follows. A
 *   harder UI-level restriction can layer on top later without changing
 *   this behavior.
 *
 * Failure modes, both rolled independently at the end of every processing
 * step (request leg AND response leg — see the docs/Agentic_AI.md §1.7
 * taxonomy):
 *
 * - `schemaFailureRate` — failure mode #1, schema violation.
 * - `hallucinationRate` — modeled here as an explicit REQUEST_FAILED,
 *   which is a deliberate simplification worth being honest about: a real
 *   hallucination usually *succeeds* at the infrastructure level while
 *   being simply wrong (§1.7: "agent failures often look like success in
 *   a trace"). This engine has no separate "succeeded but was wrong"
 *   concept for hallucination specifically — that stays an explicit
 *   failure, observable in metrics/trace, rather than a silent one.
 * - `promptInjectionRate` — failure mode #9, direct prompt injection, is
 *   the entity that DOES get the "succeeds anyway" treatment, since that's
 *   the whole point of the failure mode: attacker-controlled input
 *   overwrote this call's instructions, and the hijacked output still
 *   comes back looking like a normal, successful response. Rolled only on
 *   the success path (schema/hallucination already ruled out), it stamps
 *   `compromised: true, compromiseReason: "direct_prompt_injection"` on
 *   the metadata this call forwards or responds with — see
 *   `RequestLifecycleMetadata.compromised`'s own doc. Only a
 *   `guardrail_validator` wired downstream (its `compromiseCatchRate`) has
 *   any chance of catching this before it reaches the client; with none
 *   wired, `docs/Agentic_AI.md` §2.3's own words apply literally: "a
 *   `retriever`/`tool_call` [or here, `llm_call`] whose output isn't
 *   passed through a `guardrail_validator`."
 *
 * Cost is computed separately, in `costEngine.ts`'s `llmCallPricing` — see
 * that file's comment for why tier/quantization/deploymentTarget each
 * change the dollar readout too, not just latency/reliability.
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

export type LlmTier = "slm" | "llm";
export type LlmQuantization = "none" | "fp8" | "int8" | "int4";
export type LlmDeploymentTarget = "cloud" | "edge";

export interface LlmCallConfig {
  /** Calls this node can be actively generating at once. */
  maxConcurrent?: number;
  /** Calls allowed to wait once maxConcurrent is reached. */
  maxQueueLength?: number;
  /** Base model "thinking"/generation time, in ms, before tier/quantization/deployment multipliers. */
  processingTimeMs?: number;
  /** Random +/- jitter applied to processingTimeMs, in ms. */
  processingJitterMs?: number;
  /** Chance (0.0-1.0) this call fails schema validation on its structured output — failure mode #1. */
  schemaFailureRate?: number;
  /** Chance (0.0-1.0) this call's answer is confidently wrong — modeled as an explicit failure; see class doc. */
  hallucinationRate?: number;
  /** Chance (0.0-1.0) a successful call's output is actually hijacked by injected instructions — failure mode #9, direct prompt injection. Not a failure; see class doc. */
  promptInjectionRate?: number;
  /** SLM (fast, cheap, less reliable) vs LLM (slow, expensive, more reliable). */
  tier?: LlmTier;
  /** Weight precision — lower precision is faster/cheaper, more hallucination-prone. */
  quantization?: LlmQuantization;
  /** Cloud (network round trip) vs Edge (none, but caps effective capability — see class doc). */
  deploymentTarget?: LlmDeploymentTarget;
}

const DEFAULTS: Required<LlmCallConfig> = {
  maxConcurrent: 20,
  maxQueueLength: 100,
  processingTimeMs: 400,
  processingJitterMs: 150,
  schemaFailureRate: 0.02,
  hallucinationRate: 0.03,
  promptInjectionRate: 0.01,
  tier: "llm",
  quantization: "none",
  deploymentTarget: "cloud",
};

interface RateProfile {
  /** Multiplies compute time (processingTimeMs + jitter). */
  latencyMultiplier: number;
  /** Multiplies the configured hallucinationRate. */
  hallucinationMultiplier: number;
}

/** llm is 1x/1x — the reliable, expensive baseline every other option trades against. */
const TIER_PROFILE: Record<LlmTier, RateProfile> = {
  slm: { latencyMultiplier: 0.3, hallucinationMultiplier: 1.4 },
  llm: { latencyMultiplier: 1, hallucinationMultiplier: 1 },
};

/** none (BF16) is 1x/1x — the unquantized baseline. Illustrative multipliers, directional not measured, same spirit as costEngine.ts's own pricing disclaimers. */
const QUANTIZATION_PROFILE: Record<LlmQuantization, RateProfile> = {
  none: { latencyMultiplier: 1, hallucinationMultiplier: 1 },
  fp8: { latencyMultiplier: 0.9, hallucinationMultiplier: 1.05 },
  int8: { latencyMultiplier: 0.75, hallucinationMultiplier: 1.15 },
  int4: { latencyMultiplier: 0.6, hallucinationMultiplier: 1.5 },
};

/** Additive network round-trip time — see §1.10's sub-20ms-edge vs 200-500ms-cloud contrast. */
const DEPLOYMENT_NETWORK_LATENCY_MS: Record<LlmDeploymentTarget, number> = {
  cloud: 120,
  edge: 0,
};

/** See class doc: the honest, simulated consequence of pairing Edge with the LLM tier, instead of disabling the combination outright. */
const EDGE_LLM_PENALTY_MULTIPLIER = 3;

export class LlmCall implements Entity {
  readonly id: EntityId;

  private readonly config: Required<LlmCallConfig>;
  private readonly processor: BoundedProcessor;
  private readonly inFlight = new Map<RequestId, RequestLifecycleMetadata>();

  constructor(id: EntityId, config: LlmCallConfig = {}) {
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

    const tierProfile = TIER_PROFILE[this.config.tier];
    const quantProfile = QUANTIZATION_PROFILE[this.config.quantization];
    const edgePenalty =
      this.config.deploymentTarget === "edge" && this.config.tier === "llm"
        ? EDGE_LLM_PENALTY_MULTIPLIER
        : 1;

    const jitter = ctx.rng.nextInt(
      -this.config.processingJitterMs,
      this.config.processingJitterMs + 1
    );
    const computeMs = Math.max(
      1,
      Math.round(
        (this.config.processingTimeMs + jitter) *
          tierProfile.latencyMultiplier *
          quantProfile.latencyMultiplier *
          edgePenalty
      )
    );
    const duration = computeMs + DEPLOYMENT_NETWORK_LATENCY_MS[this.config.deploymentTarget];

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

    // Schema violation checked before hallucination — a structurally
    // malformed output never gets far enough to be evaluated for
    // correctness, same ordering a real validation pipeline would use.
    if (ctx.rng.next() < this.config.schemaFailureRate) {
      events.push(...this.fail(meta, ctx, event.requestId, "schema_violation"));
      return events;
    }

    const tierProfile = TIER_PROFILE[this.config.tier];
    const quantProfile = QUANTIZATION_PROFILE[this.config.quantization];
    const effectiveHallucinationRate = Math.min(
      1,
      this.config.hallucinationRate *
        tierProfile.hallucinationMultiplier *
        quantProfile.hallucinationMultiplier
    );
    if (ctx.rng.next() < effectiveHallucinationRate) {
      events.push(...this.fail(meta, ctx, event.requestId, "hallucinated_output"));
      return events;
    }

    // Failure mode #9 (direct prompt injection) — a "succeeds anyway"
    // compromise, not a failure. Only rolled if nothing upstream already
    // compromised this request, same "first compromise wins" simplicity
    // Retriever's own poisonedContentRate follows.
    const outgoingMeta: RequestLifecycleMetadata =
      !meta.compromised && ctx.rng.next() < this.config.promptInjectionRate
        ? { ...meta, compromised: true, compromiseReason: "direct_prompt_injection" }
        : meta;

    if (outgoingMeta.direction === "request") {
      const target = ctx.downstream[0];
      if (!target) {
        // Nothing wired downstream (no tool_call) — this call answers
        // directly instead of failing, same "safe to end a chain on"
        // reasoning APIServer.ts documents for its own no-downstream case.
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
