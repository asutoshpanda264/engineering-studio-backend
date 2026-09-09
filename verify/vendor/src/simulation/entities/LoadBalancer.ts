/**
 * The LoadBalancer spreads incoming requests across multiple downstream
 * servers instead of sending every request to just one, using whichever
 * routing algorithm it's configured with.
 *
 * ENTITIES.md doesn't document this entity (only Client is written up);
 * TECHNICAL-SPECIFICATION.md sketches its config as Algorithm / Weights /
 * Health Check Interval. Five algorithms ship — every algorithm the course
 * names for this lesson:
 *
 * - **round_robin** — deterministic, needs no state beyond a counter.
 * - **least_connections** — routes to whichever downstream target
 *   currently has the fewest in-flight requests.
 * - **weighted_round_robin** — round-robin's same cursor, cycled over a
 *   target sequence expanded by each target's configured weight instead
 *   of the bare downstream list (see `weightedSequenceFor`).
 * - **ip_hash** — routes by hashing an identifier mod target count, so
 *   the same identifier always lands on the same target (session
 *   affinity). This simulation has no modeled client IP — the closest
 *   available stand-in is `meta.key`, the same per-request identity CDN
 *   already hashes for edge affinity (see `hashRouting.ts`, extracted
 *   once a second real use case needed it). Documented substitution, not
 *   a literal IP.
 * - **least_response_time** — routes to whichever target has the lowest
 *   recent average response latency, tracked as an exponential moving
 *   average (`latencyEmaByTarget`) updated every time that target's
 *   response passes back through here. A target with no observed latency
 *   yet defaults to 0 (treated as fastest) so it gets an initial chance
 *   instead of being starved by targets with a head start on data. Every
 *   `LEAST_RESPONSE_TIME_EXPLORE_EVERY`th dispatch instead forces plain
 *   round robin regardless of measured latency — without that, a target
 *   that loses one early, jitter-driven comparison stops receiving
 *   traffic and its data goes stale, which can permanently and
 *   misleadingly lock in an uneven split between two targets that are
 *   actually identical.
 *
 * The whole point of offering more than one is comparison — round-robin
 * and least-connections behave identically when every target is equally
 * fast, and only diverge once one target is slower or overloaded;
 * weighted-round-robin and ip-hash instead diverge from plain round-robin
 * immediately, by design (a configured weight, a routing key) rather than
 * by load; least-response-time is least-connections' generalization from
 * "how many requests" to "how long they actually took." That divergence,
 * visible in the per-target request distribution (see MetricsCollector's
 * routingDistribution), is the actual lesson; a load balancer with a
 * single hardcoded algorithm can't teach it.
 *
 * Weights live on the LoadBalancer's own config (`weights`, keyed by
 * target entity id), not on the targets themselves — Local Knowledge: a
 * load balancer can't know a target's own configured "capacity," only
 * what a human operator tells it to prefer. A target with no entry
 * defaults to weight 1, so partially-specified weights degrade gracefully
 * instead of silently dropping a target from rotation.
 *
 * Least-connections tracks in-flight count per target itself (incremented
 * on dispatch, decremented when that target's response passes back
 * through here) rather than asking each target — Local Knowledge, same
 * as every other entity. A failed downstream response routes back through
 * here exactly like a successful one (see responseRouting.ts and each
 * terminal entity's `fail()` helper), so this counter decrements on
 * failure too — a fleet that starts failing doesn't look artificially
 * "busy" forever from this load balancer's point of view.
 *
 * It does forward the response leg back through itself (see
 * responseRouting.ts) even though round-robin doesn't need to observe
 * responses — least-connections and least-response-time do, and so does
 * anything sitting behind the load balancer (a Cache), and skipping that
 * leg here would silently break them.
 *
 * Unlike APIServer/Database, the LoadBalancer has no capacity of its own
 * — it makes an instant routing decision and forwards. Modeling its own
 * backpressure would conflate "which server gets this request" with
 * "is this server too busy", which Client/API/Database already teach.
 *
 * Health checks (active/passive) — the course's other named Lesson 13
 * concept — are a deliberate non-goal here, not an oversight: detecting a
 * struggling target and routing around it is exactly what Circuit Breaker
 * already teaches as its own entity (LEARNING-PARITY.md). Building a
 * second, overlapping "is this target healthy" state machine directly
 * into LoadBalancer would violate ENTITIES.md's Single Responsibility
 * principle for the same reason this class doesn't model its own
 * capacity. The Studio's answer to "how would I combine these" is
 * architectural, not a config flag: put a Circuit Breaker in front of
 * each target this LoadBalancer routes to.
 *
 * Learning goal: a single server has a capacity ceiling. Load balancing
 * is how you scale horizontally past it — but only if requests actually
 * spread evenly across replicas, and different algorithms achieve that
 * differently once replicas aren't identical.
 */

import type { Entity, SimulationContext } from "./Entity";
import type { EntityId, RequestId, Timestamp } from "../types";
import type {
  RequestLifecycleMetadata,
  SimulationEvent,
} from "../events/types";
import { findResponseTarget } from "./responseRouting";
import { hashStringToIndex } from "./hashRouting";
import { buildWeightedSequence } from "./weightedRouting";
import {
  createRequestCompletedEvent,
  createRequestFailedEvent,
  createRequestRoutedEvent,
} from "../events/EventFactory";

export type LoadBalancerAlgorithm =
  | "round_robin"
  | "least_connections"
  | "weighted_round_robin"
  | "ip_hash"
  | "least_response_time";

export interface LoadBalancerConfig {
  algorithm?: LoadBalancerAlgorithm;
  /** weighted_round_robin only — target entity id -> relative weight. A target with no entry defaults to 1. */
  weights?: Record<EntityId, number>;
}

const DEFAULTS: Required<LoadBalancerConfig> = {
  algorithm: "round_robin",
  weights: {},
};

/** Caps how far a single weight can expand the target sequence — a runaway config shouldn't turn one dispatch decision into an O(thousands) array build. */
const MAX_WEIGHT = 50;

/** How much a single fresh sample moves least_response_time's per-target average — low enough that one slow outlier doesn't cause thrashing, high enough that a target's real, sustained slowdown still shows up. */
const RESPONSE_TIME_EMA_ALPHA = 0.3;

/** least_response_time: every Nth dispatch forces plain round robin instead of picking the lowest-latency target — see selectTarget's comment on why a losing target needs to keep getting sampled. */
const LEAST_RESPONSE_TIME_EXPLORE_EVERY = 3;

export class LoadBalancer implements Entity {
  readonly id: EntityId;

  private readonly config: Required<LoadBalancerConfig>;
  private nextIndex = 0;
  /** Only meaningful (and only populated) under least_connections. */
  private readonly inFlightByTarget = new Map<EntityId, number>();
  /** Rebuilt only when the downstream list or weights actually change — see weightedSequenceFor. */
  private weightedSequenceCache: { signature: string; sequence: EntityId[] } | null = null;
  /** Only meaningful (and only populated) under least_response_time. */
  private readonly latencyEmaByTarget = new Map<EntityId, number>();
  /** Only meaningful under least_response_time — see LEAST_RESPONSE_TIME_EXPLORE_EVERY. */
  private leastResponseTimeDispatchCount = 0;
  /** Tracks which target a request is waiting on and when it was dispatched, so the response leg can compute that leg's own elapsed time — least_response_time only. */
  private readonly dispatchedAt = new Map<RequestId, { target: EntityId; at: Timestamp }>();

  constructor(id: EntityId, config: LoadBalancerConfig = {}) {
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
      this.recordCompletion(event.source);
      this.recordResponseLatency(event.source, event.requestId, ctx.now);
      return this.forwardResponse(meta, ctx, event.requestId);
    }

    if (ctx.downstream.length === 0) {
      return this.fail(meta, ctx, event.requestId, "no_downstream_connection");
    }

    const target = this.selectTarget(ctx.downstream, meta.key);
    this.recordDispatch(target);
    if (this.config.algorithm === "least_response_time") {
      this.dispatchedAt.set(event.requestId, { target, at: ctx.now });
    }

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

  private selectTarget(downstream: EntityId[], key: string): EntityId {
    if (this.config.algorithm === "least_connections") {
      // Break ties with the same round-robin cursor used below, not
      // "always the first tied target" — otherwise a fleet of equally
      // fast servers (every request finds all loads tied at 0) would
      // pile onto downstream[0] instead of splitting evenly, which
      // would defeat the point of comparing this against round_robin
      // under identical conditions.
      const minLoad = Math.min(
        ...downstream.map((target) => this.inFlightByTarget.get(target) ?? 0)
      );
      const tied = downstream.filter(
        (target) => (this.inFlightByTarget.get(target) ?? 0) === minLoad
      );
      const target = tied[this.nextIndex % tied.length];
      this.nextIndex++;
      return target;
    }

    if (this.config.algorithm === "weighted_round_robin") {
      const sequence = this.weightedSequenceFor(downstream);
      const target = sequence[this.nextIndex % sequence.length];
      this.nextIndex++;
      return target;
    }

    if (this.config.algorithm === "ip_hash") {
      // Same target every time for the same key — session affinity — not
      // a rotating cursor at all, unlike every other algorithm here.
      return downstream[hashStringToIndex(key, downstream.length)];
    }

    if (this.config.algorithm === "least_response_time") {
      this.leastResponseTimeDispatchCount++;
      // Periodic exploration, every Nth dispatch: without this, a target
      // that loses one early, noise-driven comparison stops receiving
      // traffic entirely, so its latency data goes stale and it can never
      // earn its way back in — even between two genuinely identical
      // targets, plain jitter alone can cause a permanent, misleading
      // lock-in. Forcing an occasional plain-round-robin dispatch keeps
      // every target's data fresh regardless of recent history.
      if (
        this.leastResponseTimeDispatchCount % LEAST_RESPONSE_TIME_EXPLORE_EVERY ===
        0
      ) {
        const target = downstream[this.nextIndex % downstream.length];
        this.nextIndex++;
        return target;
      }

      // Same tie-break reasoning as least_connections: without the
      // shared cursor, every request would pile onto downstream[0]
      // whenever targets are tied (which is every target, until any
      // response has come back at all).
      const minLatency = Math.min(
        ...downstream.map((target) => this.latencyEmaByTarget.get(target) ?? 0)
      );
      const tied = downstream.filter(
        (target) => (this.latencyEmaByTarget.get(target) ?? 0) === minLatency
      );
      const target = tied[this.nextIndex % tied.length];
      this.nextIndex++;
      return target;
    }

    const target = downstream[this.nextIndex % downstream.length];
    this.nextIndex++;
    return target;
  }

  /**
   * Expands `downstream` into a sequence where each target appears
   * `weight` times in a row (weights {A:3,B:1} on [A,B] -> [A,A,A,B]),
   * then the same round-robin cursor cycles over that instead of the bare
   * list — so over any full cycle, each target's share of dispatches
   * matches its weight's share of the total. Cached by a signature of
   * (downstream order + each target's weight) since the topology and
   * config don't change mid-run; only rebuilt when either actually does.
   */
  private weightedSequenceFor(downstream: EntityId[]): EntityId[] {
    const signature = downstream.map((id) => `${id}:${this.weightOf(id)}`).join(",");
    if (this.weightedSequenceCache?.signature === signature) {
      return this.weightedSequenceCache.sequence;
    }

    const sequence = buildWeightedSequence(downstream.map((id) => this.weightOf(id))).map(
      (index) => downstream[index]
    );

    this.weightedSequenceCache = { signature, sequence };
    return sequence;
  }

  private weightOf(target: EntityId): number {
    const configured = this.config.weights[target];
    if (!Number.isFinite(configured) || configured <= 0) return 1;
    return Math.min(MAX_WEIGHT, Math.round(configured));
  }

  private recordDispatch(target: EntityId): void {
    this.inFlightByTarget.set(target, (this.inFlightByTarget.get(target) ?? 0) + 1);
  }

  private recordCompletion(target: EntityId | null): void {
    if (!target) return;
    const current = this.inFlightByTarget.get(target);
    if (current === undefined) return;
    this.inFlightByTarget.set(target, Math.max(0, current - 1));
  }

  /**
   * least_response_time only: folds this response leg's elapsed time
   * (dispatch -> response arriving back here) into that target's running
   * average. Looked up by requestId rather than trusting `target` alone,
   * since a response only ever updates the specific dispatch it's
   * actually answering — and does nothing at all under any other
   * algorithm, since nothing populated `dispatchedAt` to begin with.
   */
  private recordResponseLatency(
    target: EntityId | null,
    requestId: RequestId,
    now: Timestamp
  ): void {
    const dispatch = this.dispatchedAt.get(requestId);
    this.dispatchedAt.delete(requestId);
    if (!dispatch || !target || dispatch.target !== target) return;

    const elapsed = now - dispatch.at;
    const previous = this.latencyEmaByTarget.get(target);
    const next =
      previous === undefined
        ? elapsed
        : previous * (1 - RESPONSE_TIME_EMA_ALPHA) + elapsed * RESPONSE_TIME_EMA_ALPHA;
    this.latencyEmaByTarget.set(target, next);
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
