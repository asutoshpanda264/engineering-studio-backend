/**
 * GuardrailValidator is the inline check/scorer primitive from
 * `docs/Agentic_AI.md` §2.1 — it "doubles as the Evaluator primitive" and
 * is what finally makes Reflection and Evaluator-Optimizer buildable
 * (`AgentOrchestrator.ts`'s own class doc names this exact gap). Two
 * selectable `mode`s, matching the two lessons that were written ahead of
 * this primitive and are waiting on it (`09-reflection.ts`,
 * `10-evaluator-optimizer.ts`):
 *
 * - `gate` — Reflection's shape: a binary pass/fail check.
 *   `rejectionRate` is rolled once per attempt; a rejection fails with
 *   reason "guardrail_rejected".
 * - `scorer` — Evaluator-Optimizer's shape: a graded score against
 *   `scoreThreshold`, not a coin flip. Failing here means "the score came
 *   back too low" (reason "guardrail_score_below_threshold"), a distinct,
 *   observable signal from `gate` mode's binary rejection.
 *
 * Critically, NEITHER mode implements its own retry loop. The self-
 * critique loop both lessons describe — "llm_call → guardrail_validator
 * with an edge back into the same llm_call" — falls entirely out of
 * composition with `AgentOrchestrator.ts`'s existing Sequential (Planning)
 * retry: wire `agent_orchestrator (sequential) → llm_call →
 * guardrail_validator`, and a failure here propagates back through
 * `llm_call`'s existing response-relay to the orchestrator, which
 * re-dispatches to `llm_call` again — the exact same iteration-capped
 * retry Planning already demonstrates, just with a real pass/fail
 * decision driving it instead of a blind retry count. This is the
 * concrete difference both lessons' "why this isn't buildable yet"
 * sections point at: a validator deciding whether the result is good
 * enough, not a fixed iteration count — and it required zero new
 * orchestration code, only this entity.
 *
 * `verificationMethod` (scorer mode only) makes Evaluator-Optimizer's own
 * "real risk" section literally simulatable rather than asserted: under
 * `judge` (a same-model judge grading the output — the vulnerable case
 * the lesson names), a per-`requestId` attempt counter adds
 * `judgeDriftPerAttempt` to the score on every retry of the *same*
 * logical request — later attempts sound more confident without the
 * underlying `scoreMean` actually improving, i.e. "self-corrects into a
 * more elaborate hallucination." Under `execution` (a real test suite,
 * a database's real end state), no drift is applied — the score stays
 * honestly grounded no matter how many retries occur. Comparing the two
 * on identical traffic is the direct answer to what the lesson calls "a
 * guardrail_validator that's just another llm_call judging output
 * doesn't escape the problem it's meant to catch."
 *
 * The per-requestId attempt counter is never evicted (a known, accepted
 * simplification — same spirit as LlmCall/ToolCall's documented ~2x
 * request-count overcount: not worth a fragile cleanup for a toy-scale
 * simulator's memory footprint).
 *
 * In either mode, a passing check forwards downstream if something's
 * wired there (§2.3's other named role: sitting between a `retriever`/
 * `tool_call` and an `llm_call` to catch indirect prompt injection before
 * it reaches the model) or safely ends the chain otherwise — the same
 * shape every other entity here uses. Structurally still the bounded
 * admit→queue→reject shape; only the per-mode pass/fail decision above
 * is new. No new EventType, same reasoning as Retriever.ts: the
 * distinction between "gate" and "scorer" already shows up as two
 * distinct failure reasons on the standard REQUEST_FAILED event.
 *
 * `compromiseCatchRate` is that "other named role" made concrete: an
 * independent roll, checked before gate/scorer's own evaluation, that only
 * fires when the incoming request already carries
 * `RequestLifecycleMetadata.compromised` (stamped upstream by ToolCall's
 * silentFailureRate, LlmCall's promptInjectionRate, or Retriever's
 * poisonedContentRate — failure modes #4/#9/#10). A catch fails the
 * request with the specific reason that compromised it, so the client-
 * facing failure is honest about *which* attack this was, not a generic
 * rejection. A miss leaves the compromised flag exactly as it was and
 * falls through to this node's normal gate/scorer check — content-safety
 * and output-quality are separate concerns here, each with its own
 * independent chance to catch a problem. With no guardrail_validator
 * wired at all, nothing ever rolls this check — the compromise reaches the
 * client looking like a clean success, exactly as designed.
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
  createGuardrailEvaluatedEvent,
  createProcessingCompletedEvent,
  createProcessingStartedEvent,
  createQueueFullEvent,
  createRequestCompletedEvent,
  createRequestDequeuedEvent,
  createRequestFailedEvent,
  createRequestQueuedEvent,
  createRequestRoutedEvent,
} from "../events/EventFactory";

export type GuardrailMode = "gate" | "scorer";
export type VerificationMethod = "execution" | "judge";

export interface GuardrailValidatorConfig {
  /** Checks this node can be actively running at once. */
  maxConcurrent?: number;
  /** Checks allowed to wait once maxConcurrent is reached. */
  maxQueueLength?: number;
  /** Base time for one check, in ms. */
  processingTimeMs?: number;
  /** Random +/- jitter applied to processingTimeMs, in ms. */
  processingJitterMs?: number;
  /** gate = binary pass/fail (Reflection); scorer = graded score vs threshold (Evaluator-Optimizer). */
  mode?: GuardrailMode;
  /** Chance (0.0-1.0) a check fails outright. Gate mode only. */
  rejectionRate?: number;
  /** execution = grounded in a real, checkable outcome; judge = another model's own judgment, the vulnerable case. Scorer mode only. */
  verificationMethod?: VerificationMethod;
  /** The "true" quality each attempt scores around — deliberately roughly constant across retries, since nothing here actually makes the underlying answer better. Scorer mode only. */
  scoreMean?: number;
  /** Random +/- variance applied to scoreMean on every check. Scorer mode only. */
  scoreJitter?: number;
  /** Minimum score required to pass. Scorer mode only. */
  scoreThreshold?: number;
  /** Added to the score on every retry of the same request, judge method only — the "sounds more confident without being more correct" drift. */
  judgeDriftPerAttempt?: number;
  /** Chance (0.0-1.0) an incoming request already flagged `compromised` (failure modes #4/#9/#10) is actually caught here, failing with its specific compromise reason. Both modes. */
  compromiseCatchRate?: number;
}

const DEFAULTS: Required<GuardrailValidatorConfig> = {
  maxConcurrent: 30,
  maxQueueLength: 150,
  processingTimeMs: 60,
  processingJitterMs: 20,
  mode: "gate",
  rejectionRate: 0.25,
  verificationMethod: "execution",
  scoreMean: 0.55,
  scoreJitter: 0.15,
  scoreThreshold: 0.7,
  judgeDriftPerAttempt: 0.08,
  compromiseCatchRate: 0.85,
};

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

interface InFlightEntry {
  meta: RequestLifecycleMetadata;
  attemptIndex: number;
}

export class GuardrailValidator implements Entity {
  readonly id: EntityId;

  private readonly config: Required<GuardrailValidatorConfig>;
  private readonly processor: BoundedProcessor;
  private readonly inFlight = new Map<RequestId, InFlightEntry>();
  private readonly attemptCountByRequest = new Map<RequestId, number>();

  constructor(id: EntityId, config: GuardrailValidatorConfig = {}) {
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
    const attemptIndex = (this.attemptCountByRequest.get(requestId) ?? 0) + 1;
    this.attemptCountByRequest.set(requestId, attemptIndex);
    this.inFlight.set(requestId, { meta, attemptIndex });

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
    const { meta, attemptIndex } = entry;

    const failureReason = this.evaluate(meta, attemptIndex, ctx);
    events.push(
      createGuardrailEvaluatedEvent(ctx.now, this.id, event.requestId, !failureReason, failureReason)
    );
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

  /** Returns a failure reason if this attempt fails the configured check, or null if it passes. See class doc for gate vs scorer semantics, and for compromiseCatchRate's separate content-safety roll. */
  private evaluate(
    meta: RequestLifecycleMetadata,
    attemptIndex: number,
    ctx: SimulationContext
  ): string | null {
    if (meta.compromised && ctx.rng.next() < this.config.compromiseCatchRate) {
      return meta.compromiseReason ?? "guardrail_rejected";
    }

    if (this.config.mode === "gate") {
      return ctx.rng.next() < this.config.rejectionRate ? "guardrail_rejected" : null;
    }

    const rawScore = clamp01(
      this.config.scoreMean + ctx.rng.nextFloat(-this.config.scoreJitter, this.config.scoreJitter)
    );
    const drift =
      this.config.verificationMethod === "judge"
        ? (attemptIndex - 1) * this.config.judgeDriftPerAttempt
        : 0;
    const effectiveScore = clamp01(rawScore + drift);
    return effectiveScore < this.config.scoreThreshold
      ? "guardrail_score_below_threshold"
      : null;
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
