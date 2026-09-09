/**
 * ModelRouter is `docs/Agentic_AI.md` §2.8's fourth policy-bearing
 * primitive — the SLM/LLM cascade. §1.10's 90/10 rule ("an SLM delivers
 * ~90% of an LLM's functionality at ~10% of the cost") and §1.13's
 * "~95% frontier quality at 75-85% cost cut" claims stop being trivia
 * here and become something a comparison actually demonstrates: wire two
 * `llm_call` nodes downstream (one SLM-tier, one LLM-tier — each already
 * carries its own real cost/latency/hallucination-rate profile per
 * LlmCall.ts) and this node decides, per request, which one handles it.
 *
 * **Downstream targets are role-based by wiring ORDER, not a special
 * per-target config map** — `ctx.downstream[0]` is always the cheap/SLM
 * path, `ctx.downstream[1]` (if wired) is always the escalation/LLM
 * path. This is a deliberate choice, not a shortcut: it's the exact same
 * convention AgentOrchestrator's Sequential steps and Orchestrator-
 * Worker's row-positioned workers already use, so this primitive needs
 * no new Inspector UI the way ReverseProxy's target-id-keyed `routes`
 * config does — the topology diagram alone (SLM path drawn first/above,
 * LLM path second/below) already teaches the convention.
 *
 * Four selectable `mode`s:
 *
 * - `always_llm` — every request goes to the LLM target (or the SLM
 *   target if no second one is wired) — the expensive, reliable
 *   baseline every cascade mode is measured against.
 * - `always_slm` — every request goes to the SLM target — the cheap,
 *   fast, less-reliable baseline.
 * - `confidence_cascade` — each request gets a synthetic "how confident
 *   is the SLM here" draw (`slmConfidenceMean` +/- `slmConfidenceJitter`,
 *   representing SLM calibration, not task difficulty); below
 *   `confidenceThreshold`, it escalates to the LLM target. Stateless —
 *   the identical threshold applies to every request regardless of how
 *   much has already escalated.
 * - `cost_optimized_cascade` — the same per-request confidence draw, but
 *   escalation is additionally capped by `maxEscalationRate`: a running
 *   count of requests routed vs. requests escalated so far, and any
 *   escalation that would push the observed rate over the cap is
 *   suppressed (forced to stay on the SLM target) even when confidence
 *   alone called for it. This is the literal "budget-aware threshold"
 *   §2.8 describes — modeled as a request-fraction budget rather than
 *   reimplementing `costEngine.ts`'s dollar pricing inside this entity
 *   (unnecessary: the SLM/LLM cost differential already shows up for
 *   free once both downstream `llm_call` nodes are separately priced —
 *   see the Cost panel).
 *
 * Structurally this is LoadBalancer.ts's "no capacity of its own"
 * shape, not the bounded admit→queue→reject shape most other entities
 * here use — an instant routing decision, then forward. Modeling its own
 * backpressure would conflate "which model tier handles this" with "is
 * this router too busy", the same reasoning LoadBalancer's own class doc
 * gives for the identical choice.
 *
 * No new EventType or metric: which target won each dispatch is already
 * derived generically from REQUEST_ROUTED events by MetricsCollector's
 * existing `routingDistribution` — the exact mechanism LoadBalancer's own
 * per-target split and AgentOrchestrator's own dispatch distribution
 * already use. Registered in `ComponentNode.tsx`'s/`InspectorPanel.tsx`'s
 * `ROUTING_ENTITY_TYPES` gating so the Inspector's distribution section
 * renders for free — the SLM-vs-LLM split IS the comparison this
 * primitive exists to make visible.
 */

import type { Entity, SimulationContext } from "./Entity";
import type { EntityId, RequestId } from "../types";
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

export type RouterMode =
  | "always_llm"
  | "always_slm"
  | "confidence_cascade"
  | "cost_optimized_cascade";

export interface ModelRouterConfig {
  mode?: RouterMode;
  /** Mean of the SLM's own self-reported confidence per request (0.0-1.0) — calibration, not task difficulty. Cascade modes only. */
  slmConfidenceMean?: number;
  /** Random +/- jitter applied to slmConfidenceMean. Cascade modes only. */
  slmConfidenceJitter?: number;
  /** Escalates to the LLM target when the confidence draw falls below this. Cascade modes only. */
  confidenceThreshold?: number;
  /** Hard cap on what fraction of routed traffic is allowed to escalate, tracked over the run so far. Cost-optimized-cascade only. */
  maxEscalationRate?: number;
}

const DEFAULTS: Required<ModelRouterConfig> = {
  mode: "confidence_cascade",
  slmConfidenceMean: 0.65,
  slmConfidenceJitter: 0.2,
  confidenceThreshold: 0.6,
  maxEscalationRate: 0.3,
};

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

export class ModelRouter implements Entity {
  readonly id: EntityId;

  private readonly config: Required<ModelRouterConfig>;
  /** cost_optimized_cascade only. */
  private totalRouted = 0;
  private totalEscalated = 0;

  constructor(id: EntityId, config: ModelRouterConfig = {}) {
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

  private selectTarget(downstream: EntityId[], ctx: SimulationContext): EntityId {
    const slmTarget = downstream[0];
    const llmTarget = downstream[1] ?? downstream[0];

    if (this.config.mode === "always_llm") return llmTarget;
    if (this.config.mode === "always_slm") return slmTarget;

    const confidence = clamp01(
      this.config.slmConfidenceMean +
        ctx.rng.nextFloat(-this.config.slmConfidenceJitter, this.config.slmConfidenceJitter)
    );
    const wantsEscalation = confidence < this.config.confidenceThreshold && llmTarget !== slmTarget;

    if (this.config.mode === "confidence_cascade") {
      return wantsEscalation ? llmTarget : slmTarget;
    }

    // cost_optimized_cascade: the same confidence signal, additionally
    // throttled by a running budget — escalating is only allowed if doing
    // so wouldn't push the observed escalation rate over the cap.
    this.totalRouted++;
    if (wantsEscalation) {
      const wouldBeRate = (this.totalEscalated + 1) / this.totalRouted;
      if (wouldBeRate <= this.config.maxEscalationRate) {
        this.totalEscalated++;
        return llmTarget;
      }
    }
    return slmTarget;
  }

  /** Instant pass-through — no capacity check, same reasoning as LoadBalancer.ts's identical helper. */
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

  /** See LoadBalancer.ts's identical helper. */
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
