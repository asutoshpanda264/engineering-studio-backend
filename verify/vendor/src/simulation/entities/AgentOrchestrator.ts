/**
 * The AgentOrchestrator routes, plans, and loops — the primitive
 * `docs/Agentic_AI.md` §2.1 assigns "owns the iteration cap" to, and maps
 * to an `invoke_agent` span in that doc's tracing vocabulary (§1.6/§2.4,
 * not yet implemented). Two of the six canonical patterns fall directly
 * out of this entity's `routingMode`:
 *
 * - **Planning** (`sequential`) — dispatches to its downstream targets
 *   one at a time, in order, only advancing to the next once the current
 *   one succeeds. A failed step retries in place (same target, same
 *   requestId) up to `maxIterations` attempts before the whole session
 *   fails — this is where failure mode #5 (infinite retry loop, §1.7)
 *   lives: set `maxIterations` very high against an always-failing
 *   downstream target and watch that target's own requestCount balloon
 *   far past what one logical request should ever cause.
 * - **Orchestrator-Worker** (`parallel`) — dispatches to every downstream
 *   target at once (the *same* discrete-event timestamp, unlike
 *   `sequential`'s staggered dispatches — this is what makes the two
 *   modes "demonstrably distinct in their event traces" per Phase 2's own
 *   acceptance criterion, no new visualization needed), waits for every
 *   one to report back (independently retried up to `maxIterations` each
 *   on failure), then synthesizes: any worker that's still failed once
 *   its own retries are exhausted fails the whole session.
 *
 * Structurally this is a genuine departure from every other entity in
 * this engine so far (APIServer, Database, LlmCall, ToolCall): those are
 * all "one admission = one hop out, one hop back." This entity holds a
 * *session* across potentially many hops for one admitted unit of work —
 * the BoundedProcessor slot it admits on arrival stays occupied for the
 * session's entire lifetime (every step/worker, every retry), not just a
 * single fixed-duration processing step, since a real orchestrator
 * genuinely holds session state/resources for as long as it's
 * coordinating. `sessions` (keyed by requestId) is the extra bookkeeping
 * that shape requires; nothing else here — the response-routing helpers,
 * the admit/queue/reject shape — deviates from the established pattern.
 *
 * `path`/response-routing note: the extended `RequestLifecycleMetadata`
 * this entity builds once per session (path + this.id, direction
 * "request") is reused, unmodified, for every dispatch AND for the final
 * respond()/fail() call — `findResponseTarget` resolves identically
 * whether or not `this.id` is already present in `path`, so there's no
 * need to track a separate "original vs. extended" meta the way it might
 * first appear necessary.
 *
 * Reflection and Evaluator-Optimizer (the other two patterns that route
 * through an orchestrator's loop, per §2.1) need `guardrail_validator` —
 * a self-critique/scoring step this entity deliberately doesn't
 * approximate — so they aren't buildable until that primitive lands in
 * Phase 3. Multi-Agent Collaboration (2+ orchestrators exchanging
 * A2A-shaped peer messages) is buildable today simply by wiring two
 * AgentOrchestrator nodes to each other — no additional entity code
 * needed beyond what's here.
 *
 * Not priced in `costEngine.ts` yet — deliberately deferred, same "not
 * every entity needs a pricing model on day one" precedent Client already
 * sets, rather than inventing a number this doc's research doesn't ground.
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

export type OrchestratorRoutingMode = "sequential" | "parallel";

export interface AgentOrchestratorConfig {
  /** sequential = Planning (one step at a time); parallel = Orchestrator-Worker (fan out to all at once). */
  routingMode?: OrchestratorRoutingMode;
  /** Total attempts allowed per step/worker (including the first) before that step/worker is given up on. */
  maxIterations?: number;
  /** Sessions this node can be actively coordinating at once. */
  maxConcurrent?: number;
  /** Sessions allowed to wait once maxConcurrent is reached. */
  maxQueueLength?: number;
  /** One-time planning/reasoning delay before the first dispatch of a new session, in ms. */
  processingTimeMs?: number;
  /** Random +/- jitter applied to processingTimeMs, in ms. */
  processingJitterMs?: number;
}

const DEFAULTS: Required<AgentOrchestratorConfig> = {
  routingMode: "sequential",
  maxIterations: 3,
  maxConcurrent: 10,
  maxQueueLength: 50,
  processingTimeMs: 50,
  processingJitterMs: 15,
};

interface SequentialSession {
  mode: "sequential";
  meta: RequestLifecycleMetadata;
  stepIndex: number;
  attempts: number;
}

interface ParallelSession {
  mode: "parallel";
  meta: RequestLifecycleMetadata;
  targets: EntityId[];
  attemptsByTarget: Map<EntityId, number>;
  doneTargets: Set<EntityId>;
  anyFailed: boolean;
  failureReason?: string;
}

type Session = SequentialSession | ParallelSession;

export class AgentOrchestrator implements Entity {
  readonly id: EntityId;

  private readonly config: Required<AgentOrchestratorConfig>;
  private readonly processor: BoundedProcessor;
  private readonly sessions = new Map<RequestId, Session>();

  constructor(id: EntityId, config: AgentOrchestratorConfig = {}) {
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
      const meta = event.metadata as RequestLifecycleMetadata;
      if (meta.direction === "response") {
        return this.onChildResponse(event, ctx);
      }
      return this.onArrival(event, ctx);
    }
    // Purely informational (utilization/requestCount bookkeeping already
    // happened at PROCESSING_STARTED/dispatch time) — a session's real
    // lifecycle is event-driven off child responses, not a scheduled
    // wake-up, so this has nothing left to do.
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
    return this.beginSession(event.requestId, meta, ctx);
  }

  private beginSession(
    requestId: RequestId,
    meta: RequestLifecycleMetadata,
    ctx: SimulationContext
  ): SimulationEvent[] {
    const events: SimulationEvent[] = [createProcessingStartedEvent(ctx.now, this.id, requestId)];

    if (ctx.downstream.length === 0) {
      // Nothing to orchestrate — safe to end a chain on, same reasoning
      // every other entity's no-downstream case documents. No session is
      // held; free the slot immediately.
      events.push(createProcessingCompletedEvent(ctx.now, this.id, requestId));
      events.push(...this.releaseSlotAndAdvanceQueue(ctx));
      events.push(...this.respond(meta, ctx, requestId));
      return events;
    }

    const jitter = ctx.rng.nextInt(
      -this.config.processingJitterMs,
      this.config.processingJitterMs + 1
    );
    const planningDelay = Math.max(0, this.config.processingTimeMs + jitter);

    const sessionMeta: RequestLifecycleMetadata = {
      ...meta,
      direction: "request",
      path: [...meta.path, this.id],
    };

    if (this.config.routingMode === "parallel") {
      const targets = [...ctx.downstream];
      const attemptsByTarget = new Map<EntityId, number>();
      for (const target of targets) attemptsByTarget.set(target, 1);
      this.sessions.set(requestId, {
        mode: "parallel",
        meta: sessionMeta,
        targets,
        attemptsByTarget,
        doneTargets: new Set(),
        anyFailed: false,
      });
      for (const target of targets) {
        events.push(this.dispatchTo(target, requestId, sessionMeta, ctx, planningDelay));
      }
    } else {
      this.sessions.set(requestId, {
        mode: "sequential",
        meta: sessionMeta,
        stepIndex: 0,
        attempts: 1,
      });
      events.push(this.dispatchTo(ctx.downstream[0], requestId, sessionMeta, ctx, planningDelay));
    }

    return events;
  }

  private dispatchTo(
    target: EntityId,
    requestId: RequestId,
    sessionMeta: RequestLifecycleMetadata,
    ctx: SimulationContext,
    extraDelayMs = 0
  ): SimulationEvent {
    const latency = ctx.latencyTo(target) + extraDelayMs;
    return createRequestRoutedEvent(ctx.now + latency, this.id, target, requestId, sessionMeta);
  }

  private onChildResponse(
    event: SimulationEvent,
    ctx: SimulationContext
  ): SimulationEvent[] {
    if (!event.requestId || !event.source) return [];
    const session = this.sessions.get(event.requestId);
    if (!session) return []; // defensive — a response with no matching session is a no-op, not a crash

    const meta = event.metadata as RequestLifecycleMetadata;
    const failed = meta.failed === true;

    if (session.mode === "sequential") {
      return this.advanceSequential(event.requestId, session, failed, ctx);
    }
    return this.advanceParallel(event.requestId, session, event.source, failed, meta, ctx);
  }

  private advanceSequential(
    requestId: RequestId,
    session: SequentialSession,
    failed: boolean,
    ctx: SimulationContext
  ): SimulationEvent[] {
    const currentTarget = ctx.downstream[session.stepIndex];

    if (failed) {
      if (session.attempts < this.config.maxIterations) {
        session.attempts++;
        return [this.dispatchTo(currentTarget, requestId, session.meta, ctx)];
      }
      this.sessions.delete(requestId);
      return this.finalizeSession(requestId, session.meta, ctx, "iteration_limit_exceeded");
    }

    session.stepIndex++;
    session.attempts = 1;
    if (session.stepIndex >= ctx.downstream.length) {
      this.sessions.delete(requestId);
      return this.finalizeSession(requestId, session.meta, ctx, null);
    }
    return [this.dispatchTo(ctx.downstream[session.stepIndex], requestId, session.meta, ctx)];
  }

  private advanceParallel(
    requestId: RequestId,
    session: ParallelSession,
    source: EntityId,
    failed: boolean,
    meta: RequestLifecycleMetadata,
    ctx: SimulationContext
  ): SimulationEvent[] {
    if (session.doneTargets.has(source)) return []; // already resolved — a stray late event, ignore

    if (failed) {
      const attempts = (session.attemptsByTarget.get(source) ?? 1) + 1;
      if (attempts <= this.config.maxIterations) {
        session.attemptsByTarget.set(source, attempts);
        return [this.dispatchTo(source, requestId, session.meta, ctx)];
      }
      session.doneTargets.add(source);
      session.anyFailed = true;
      session.failureReason = session.failureReason ?? meta.failureReason ?? "worker_failed";
    } else {
      session.doneTargets.add(source);
    }

    if (session.doneTargets.size < session.targets.length) {
      return []; // still waiting on other workers
    }

    this.sessions.delete(requestId);
    return this.finalizeSession(
      requestId,
      session.meta,
      ctx,
      session.anyFailed ? (session.failureReason ?? "worker_failed") : null
    );
  }

  private finalizeSession(
    requestId: RequestId,
    meta: RequestLifecycleMetadata,
    ctx: SimulationContext,
    failureReason: string | null
  ): SimulationEvent[] {
    const events: SimulationEvent[] = [createProcessingCompletedEvent(ctx.now, this.id, requestId)];
    events.push(...this.releaseSlotAndAdvanceQueue(ctx));
    events.push(
      ...(failureReason
        ? this.fail(meta, ctx, requestId, failureReason)
        : this.respond(meta, ctx, requestId))
    );
    return events;
  }

  /** Frees this session's BoundedProcessor slot and, if a queued session was waiting, starts it. */
  private releaseSlotAndAdvanceQueue(ctx: SimulationContext): SimulationEvent[] {
    const nextQueued = this.processor.complete();
    if (!nextQueued || !nextQueued.requestId) return [];
    const events: SimulationEvent[] = [
      createRequestDequeuedEvent(ctx.now, this.id, nextQueued.requestId),
    ];
    events.push(
      ...this.beginSession(
        nextQueued.requestId,
        nextQueued.metadata as RequestLifecycleMetadata,
        ctx
      )
    );
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
