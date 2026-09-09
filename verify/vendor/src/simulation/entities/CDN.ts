/**
 * The CDN answers requests from one of several geographically distributed
 * edge caches instead of a single central one, falling through to the
 * origin (whatever's connected downstream) on a miss — same cache-aside
 * idea as Cache, just replicated across edges that are each closer to
 * *some* users than a single origin server could be.
 *
 * TECHNICAL-SPECIFICATION.md sketches CDN as "5 geographic edges, a
 * latency matrix, TLS/DDoS modeling, a cost calculator, world map
 * visualization." This implements the part that's actually entity
 * *behavior* — edge count, per-edge distance-to-user, and per-edge
 * cache-aside — since that's what teaches the real lesson (latency is
 * partly a physics problem). TLS/DDoS modeling and a cost calculator
 * aren't entity behavior, they're separate features with their own
 * logic; a world map visualization is a geo UI component. All three are
 * real follow-ups, not silently faked here.
 *
 * The user and the origin are both real, placeable points on a schematic
 * (not geographic) 0–100 plane — `userX`/`userY`, `originX`/`originY` —
 * not just an assertion of "closer is faster." Edges sit at fixed,
 * auto-arranged positions on the same plane (evenly spaced on a ring —
 * see `computeEdgePositions`; not independently placeable, to keep the
 * diagram readable at a glance). Two things follow directly from where
 * the User pin sits:
 *
 * 1. **Latency-to-user per edge** is that edge's real distance to the
 *    User pin, linearly mapped into [minEdgeLatencyMs, maxEdgeLatencyMs]
 *    (`computeEdgeLatencies`) — the nearest edge gets the min, the
 *    farthest gets the max. Move the pin, the numbers move with it.
 * 2. **Which edge answers a given request** is no longer content-hashed
 *    (a key no longer sticks to one edge) — it's proximity-weighted:
 *    each edge's share of dispatches is proportional to `1 / distance`
 *    from the User pin, expanded into a repeating sequence and cycled
 *    the same way LoadBalancer's Weighted Round Robin already does
 *    (`weightedRouting.ts`). The nearest edge doesn't just answer
 *    faster, it answers *more often* — and so builds a hotter cache too,
 *    a second, compounding benefit of proximity. The tradeoff: a given
 *    key can now land on different edges across requests, since routing
 *    no longer depends on the key at all — real anycast/geo-DNS
 *    stickiness (same content, same edge, always) isn't modeled here
 *    anymore, in exchange for making "proximity decides" an observable,
 *    literal fact instead of a fixed per-index spread.
 *
 * The Origin pin's position is context for the diagram — *why* a miss
 * costs what it costs — not a second latency model wired into the
 * simulation. The miss path's actual travel time still comes from the
 * downstream graph connection's own configured latency (`ctx.latencyTo`),
 * the same as every other entity's downstream hop; CDN doesn't compute a
 * second, competing distance-based number for that leg.
 *
 * Learning goal: more edges mean better worst-case latency (some point on
 * the plane is always closer to *an* edge), but each edge caches
 * independently, so splitting the same traffic across more edges can
 * mean each one is individually colder — proximity and hit rate pull in
 * different directions, and a CDN is a bet that proximity wins. Now
 * literal: drag the User pin toward an edge and watch that edge's
 * latency drop *and* its hit rate climb, at the same time.
 */

import type { Entity, SimulationContext } from "./Entity";
import type { EntityId, RequestId } from "../types";
import type {
  RequestLifecycleMetadata,
  SimulationEvent,
} from "../events/types";
import { BoundedProcessor } from "./BoundedProcessor";
import { CacheStore } from "./CacheStore";
import type { EvictionPolicy } from "./CacheStore";
import { findResponseTarget } from "./responseRouting";
import { buildWeightedSequence } from "./weightedRouting";
import {
  createCacheAccessEvent,
  createProcessingCompletedEvent,
  createProcessingStartedEvent,
  createQueueFullEvent,
  createRequestCompletedEvent,
  createRequestDequeuedEvent,
  createRequestFailedEvent,
  createRequestQueuedEvent,
  createRequestRoutedEvent,
} from "../events/EventFactory";

export type { EvictionPolicy };

export interface PlanePoint {
  x: number;
  y: number;
}

/** Schematic plane both the entity and the UI place edges/User/Origin
 * on — 0–100 both axes, not real coordinates. */
const PLANE_CENTER: PlanePoint = { x: 50, y: 50 };
const EDGE_RING_RADIUS = 38;

/** Sensible defaults placing User and Origin outside the edge ring
 * (which spans roughly [12, 88] around the plane center) so they don't
 * default on top of an edge. */
export const DEFAULT_USER_POSITION: PlanePoint = { x: 8, y: 50 };
export const DEFAULT_ORIGIN_POSITION: PlanePoint = { x: 92, y: 50 };

function distance(a: PlanePoint, b: PlanePoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Fixed, auto-arranged edge positions on the schematic plane — evenly
 * spaced on a ring around the center, purely a function of edge count.
 * Exported so the UI places the same dots the entity actually routes to,
 * without recomputing a second, potentially-drifting copy of this
 * formula (same reasoning as `computeEdgeLatencies` below).
 */
export function computeEdgePositions(edgeCount: number): PlanePoint[] {
  const count = Math.max(1, edgeCount);
  return Array.from({ length: count }, (_, i) => {
    const angleRadians = ((-90 + (360 * i) / count) * Math.PI) / 180;
    return {
      x: PLANE_CENTER.x + EDGE_RING_RADIUS * Math.cos(angleRadians),
      y: PLANE_CENTER.y + EDGE_RING_RADIUS * Math.sin(angleRadians),
    };
  });
}

/**
 * One-way latency to each edge, linearly mapped from that edge's real
 * distance to the User pin into [min, max] — the nearest edge gets the
 * min, the farthest gets the max. Exported so the UI can render the same
 * numbers the entity actually uses (e.g. the Edge Map) without
 * recomputing a second, potentially-drifting copy of this formula.
 */
export function computeEdgeLatencies(
  edgeCount: number,
  minEdgeLatencyMs: number,
  maxEdgeLatencyMs: number,
  userX: number = DEFAULT_USER_POSITION.x,
  userY: number = DEFAULT_USER_POSITION.y
): number[] {
  const count = Math.max(1, edgeCount);
  if (count === 1) return [minEdgeLatencyMs];

  const positions = computeEdgePositions(count);
  const distances = positions.map((p) => distance(p, { x: userX, y: userY }));
  const minDist = Math.min(...distances);
  const maxDist = Math.max(...distances);
  if (maxDist === minDist) {
    return distances.map(() => Math.round((minEdgeLatencyMs + maxEdgeLatencyMs) / 2));
  }
  return distances.map((d) => {
    const t = (d - minDist) / (maxDist - minDist);
    return Math.round(minEdgeLatencyMs + t * (maxEdgeLatencyMs - minEdgeLatencyMs));
  });
}

/** Caps how far a single edge's proximity can expand the routing
 * sequence — the same runaway-config guard LoadBalancer's Weighted Round
 * Robin uses (MAX_WEIGHT there), scoped smaller here since CDN edge
 * counts are typically single digits. */
const MAX_EDGE_WEIGHT = 20;
/** Floor under distance before inverting it to a weight, so a User pin
 * placed exactly on an edge doesn't divide by zero. */
const MIN_DISTANCE = 1;

/**
 * Each edge's share of dispatches, proportional to `1 / distance` from
 * the User pin — the farthest edge is normalized to weight 1, nearer
 * edges scale up from there (capped at MAX_EDGE_WEIGHT), then expanded
 * into a round-robin sequence via the same mechanism LoadBalancer's
 * Weighted Round Robin uses.
 */
function computeProximityWeights(positions: PlanePoint[], user: PlanePoint): number[] {
  const rawWeights = positions.map((p) => 1 / Math.max(distance(p, user), MIN_DISTANCE));
  const minRaw = Math.min(...rawWeights);
  return rawWeights.map((w) => Math.max(1, Math.min(MAX_EDGE_WEIGHT, Math.round(w / minRaw))));
}

export interface CDNConfig {
  /** How many geographically distributed edges the CDN operates. */
  edgeCount?: number;
  /** One-way latency to the nearest edge, in ms. */
  minEdgeLatencyMs?: number;
  /** One-way latency to the farthest edge, in ms. */
  maxEdgeLatencyMs?: number;
  /** Where the user sits on the schematic 0–100 plane — drives both
   * per-edge latency and which edge gets more of the traffic. */
  userX?: number;
  userY?: number;
  /** Where the origin sits on the schematic 0–100 plane — context for
   * the diagram; doesn't drive the miss path's actual simulated latency
   * (see class doc). */
  originX?: number;
  originY?: number;
  /** Distinct keys each edge can hold before it must evict something. */
  capacity?: number;
  /** Which entry an edge removes when a new key arrives at its capacity. */
  evictionPolicy?: EvictionPolicy;
  /** How long an entry stays valid at an edge, in ms. 0 = never expires. */
  ttlMs?: number;
  /** Lookups/stores a single edge can be actively handling at once. */
  maxConcurrent?: number;
  /** Requests allowed to wait once an edge is at maxConcurrent. */
  maxQueueLength?: number;
  /** Time to serve a hit, in ms, on top of the edge's latency-to-user. */
  hitTimeMs?: number;
  /** Extra bookkeeping time added on a miss, on top of the origin's own latency. */
  missOverheadMs?: number;
}

const DEFAULTS: Required<CDNConfig> = {
  edgeCount: 5,
  minEdgeLatencyMs: 1,
  maxEdgeLatencyMs: 6,
  userX: DEFAULT_USER_POSITION.x,
  userY: DEFAULT_USER_POSITION.y,
  originX: DEFAULT_ORIGIN_POSITION.x,
  originY: DEFAULT_ORIGIN_POSITION.y,
  capacity: 20,
  evictionPolicy: "lru",
  ttlMs: 0,
  maxConcurrent: 20,
  maxQueueLength: 100,
  hitTimeMs: 1,
  missOverheadMs: 1,
};

interface InFlightRecord {
  meta: RequestLifecycleMetadata;
  edgeIndex: number;
  /** Only meaningful when meta.direction === "request". */
  hit: boolean;
}

/** Metadata CDN piggybacks on the request while it's away at the origin,
 * so the response can be attributed back to the edge that missed on it —
 * RequestLifecycleMetadata's index signature allows entity-specific
 * fields like this without polluting the shared, typed shape. */
interface CDNResponseMetadata extends RequestLifecycleMetadata {
  cdnEdgeIndex?: number;
}

export class CDN implements Entity {
  readonly id: EntityId;

  private readonly config: Required<CDNConfig>;
  private readonly processor: BoundedProcessor;
  private readonly edges: CacheStore[];
  /** One-way latency to each edge, derived from its real distance to the
   * User pin — deterministic by construction, since entities don't
   * receive an RNG until handleEvent runs. */
  private readonly edgeLatencyMs: number[];
  /** Proximity-weighted routing sequence — see computeProximityWeights.
   * A plain cursor (not RNG-driven) cycles over this, the same
   * deterministic mechanism LoadBalancer's Weighted Round Robin uses. */
  private readonly edgeRoutingSequence: number[];
  private edgeSelectionCursor = 0;
  private readonly inFlight = new Map<RequestId, InFlightRecord>();

  constructor(id: EntityId, config: CDNConfig = {}) {
    this.id = id;
    this.config = { ...DEFAULTS, ...config };
    this.processor = new BoundedProcessor(
      this.config.maxConcurrent,
      this.config.maxQueueLength
    );

    const edgeCount = Math.max(1, this.config.edgeCount);
    this.edges = Array.from(
      { length: edgeCount },
      () =>
        new CacheStore({
          capacity: this.config.capacity,
          evictionPolicy: this.config.evictionPolicy,
          ttlMs: this.config.ttlMs,
        })
    );
    const user = { x: this.config.userX, y: this.config.userY };
    this.edgeLatencyMs = computeEdgeLatencies(
      edgeCount,
      this.config.minEdgeLatencyMs,
      this.config.maxEdgeLatencyMs,
      user.x,
      user.y
    );
    const positions = computeEdgePositions(edgeCount);
    this.edgeRoutingSequence = buildWeightedSequence(
      computeProximityWeights(positions, user)
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
    const meta = event.metadata as CDNResponseMetadata;

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

  /** Proximity-weighted edge routing: cycles the shared cursor over
   * edgeRoutingSequence, so over any full cycle each edge's share of
   * dispatches matches its distance-derived weight — see the class doc
   * for why this replaced content-key hashing. */
  private selectEdge(): number {
    const edgeIndex = this.edgeRoutingSequence[
      this.edgeSelectionCursor % this.edgeRoutingSequence.length
    ];
    this.edgeSelectionCursor++;
    return edgeIndex;
  }

  private beginProcessing(
    requestId: RequestId,
    meta: CDNResponseMetadata,
    ctx: SimulationContext
  ): SimulationEvent[] {
    const isRequestLeg = meta.direction === "request";
    // A response leg carries the edge it originally missed on; a request
    // leg is routed proximity-weighted from the User pin (see class doc)
    // — independent of the request's content key.
    const edgeIndex = isRequestLeg ? this.selectEdge() : (meta.cdnEdgeIndex ?? 0);
    const edge = this.edges[edgeIndex];

    const hit = isRequestLeg && edge.lookup(meta.key, ctx.now) === "hit";
    if (isRequestLeg && hit) edge.touch(meta.key, ctx.now);

    this.inFlight.set(requestId, { meta, edgeIndex, hit });

    const workTime = isRequestLeg
      ? hit
        ? this.config.hitTimeMs
        : this.config.missOverheadMs
      : this.config.hitTimeMs;
    // Distance to the user applies on both legs — once reaching the edge,
    // once again on the way back — the same way connection latency
    // between two graph-connected entities applies each direction.
    const duration = Math.max(
      1,
      this.edgeLatencyMs[edgeIndex] + workTime + ctx.rng.nextInt(0, 2)
    );

    const events: SimulationEvent[] = [
      createProcessingStartedEvent(ctx.now, this.id, requestId),
    ];
    if (isRequestLeg) {
      events.push(
        createCacheAccessEvent(
          hit ? "CACHE_HIT" : "CACHE_MISS",
          ctx.now,
          this.id,
          requestId,
          meta.key,
          hit,
          { edgeIndex }
        )
      );
    }
    events.push(
      createProcessingCompletedEvent(ctx.now + duration, this.id, requestId)
    );
    return events;
  }

  private onProcessingComplete(
    event: SimulationEvent,
    ctx: SimulationContext
  ): SimulationEvent[] {
    if (!event.requestId) return [];
    const record = this.inFlight.get(event.requestId);
    this.inFlight.delete(event.requestId);

    const events: SimulationEvent[] = [];

    const nextQueued = this.processor.complete();
    if (nextQueued && nextQueued.requestId) {
      events.push(createRequestDequeuedEvent(ctx.now, this.id, nextQueued.requestId));
      events.push(
        ...this.beginProcessing(
          nextQueued.requestId,
          nextQueued.metadata as CDNResponseMetadata,
          ctx
        )
      );
    }

    if (!record) return events;
    const { meta, edgeIndex, hit } = record;

    if (meta.direction === "request") {
      if (hit) {
        events.push(...this.respond(meta, ctx, event.requestId));
        return events;
      }

      const target = ctx.downstream[0];
      if (!target) {
        events.push(...this.fail(meta, ctx, event.requestId, "no_downstream_connection"));
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
            cdnEdgeIndex: edgeIndex,
          }
        )
      );
    } else {
      // The value we missed on has come back from the origin — store it
      // at the edge that originally missed, then continue the response.
      // Only when it actually succeeded: a failed origin fetch has
      // nothing worth caching at this edge.
      if (!meta.failed) this.edges[edgeIndex].set(meta.key, ctx.now);
      events.push(...this.respond(meta, ctx, event.requestId));
    }

    return events;
  }

  private respond(
    meta: RequestLifecycleMetadata,
    ctx: SimulationContext,
    requestId: string
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
          : createRequestCompletedEvent(ctx.now, this.id, target, requestId, duration),
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
