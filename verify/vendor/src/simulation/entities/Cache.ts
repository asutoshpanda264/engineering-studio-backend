/**
 * The Cache answers requests from memory when it can, falling through to
 * whatever's behind it (typically a Database) when it can't.
 *
 * ENTITIES.md doesn't document this entity; TECHNICAL-SPECIFICATION.md
 * only sketches Cache config as Capacity / TTL / Eviction Policy. This
 * implements the cache-aside pattern specifically: check cache first: a
 * hit answers immediately without ever touching downstream; a miss falls
 * through, and the fetched value is stored on the way back. Write-through
 * / write-back / write-around are read+write coordination protocols —
 * meaningless without the engine modeling writes as a distinct kind of
 * request, which it doesn't yet. That's a real follow-up, not this pass.
 *
 * Like APIServer/Database, both directions (the inbound request AND the
 * database's returning response, when the request missed) go through
 * the same bounded concurrency/queue admission — a cache does have
 * finite throughput even though its work is fast.
 *
 * `stampedeMode` models cache stampede — the production failure where a
 * popular key's value disappears (TTL expiry, cold start) while many
 * requests for it are still arriving, and every one of them independently
 * re-fetches from downstream at once, multiplying load on exactly what a
 * cache exists to protect. Two comparable modes ship (LEARNING-PARITY.md:
 * "ship two comparable options, not one hardcoded default", the same
 * precedent as Load Balancer's algorithms): "naive" is a plain miss, one
 * downstream fetch per request, same as before this existed. "coalesced"
 * is request coalescing / single-flight — the first miss for a key
 * becomes that key's leader and fetches; any other miss for the same key
 * that arrives before the leader's fetch resolves waits on it instead of
 * fetching independently, then shares whatever the leader got (value or
 * failure). A waiting follower still occupies its admitted
 * concurrency/queue slot for the whole wait — coalescing trades
 * "downstream sees fewer fetches" for "this cache holds the waiting
 * request open," a real cost, not a free lunch.
 *
 * `negativeCaching` models cache penetration — repeated lookups for a key
 * that will never exist (a typo'd id, a deleted record, an attacker
 * probing for valid ids; see RequestLifecycleMetadata.exists, set by the
 * Client's Missing Key Rate). This engine's downstream entities (Database,
 * ...) have no concept of per-key existence, so Cache is the one place
 * that knows a request is for a phantom key — on the way back from
 * downstream it deterministically resolves such a request as "not found",
 * regardless of what downstream itself reported, the same simplification
 * Database.ts already makes for query correctness generally. "off" (the
 * default): every miss for that key makes its own full downstream round
 * trip, forever — the vulnerability itself. "on": the first not-found
 * result is cached too (for `negativeCacheTtlMs`), so a repeat lookup for
 * the same phantom key is answered straight from Cache — negative caching,
 * the standard production fix.
 *
 * `ttlJitterPercent` models cache avalanche — many unrelated keys expiring
 * around the same moment (typically because they were all first cached
 * around the same moment, e.g. a cold start), causing a synchronized wave
 * of downstream re-fetches right when the cache should be absorbing load.
 * 0 (the default) stores every entry with the exact same TTL, so a batch
 * cached together expires together. A positive value randomizes each
 * entry's own effective TTL by up to that fraction above/below the
 * configured TTL at the moment it's stored, staggering expiries — TTL
 * jitter, the standard production fix.
 *
 * Learning goal: a cache only helps when the same key is requested
 * often enough to be worth remembering — hit rate is a property of both
 * the cache (capacity, eviction policy) and the traffic (how repetitive
 * it actually is), not something a cache can force on its own.
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

export type CacheStampedeMode = "naive" | "coalesced";
export type NegativeCachingMode = "off" | "on";
export type CachingMode = "exact" | "semantic";

export interface CacheConfig {
  /**
   * "exact" (the default, and every behavior above this field's addition)
   * answers a hit only when `meta.key` itself is already stored. "semantic"
   * — docs/Agentic_AI.md §2.9's semantic caching, cache-aside in front of
   * an llm_call with a "hit" redefined as similarity-above-threshold — adds
   * an EXTRA chance of hitting even on a key that was never stored,
   * standing in for "a semantically-similar-enough query was answered
   * before." Modeled as a flat probability (`semanticHitRate`), scaled by
   * how full the store currently is (more cached entries = more chances
   * something is similar enough) — illustrative, not real embedding
   * similarity, same "directional, not measured" spirit as every other
   * probability table in this simulator. Negative Caching and Stampede
   * Protection stay exact-key concerns either way — "this specific key is
   * confirmed nonexistent" doesn't have an honest fuzzy-similarity analog.
   */
  cachingMode?: CachingMode;
  /** Chance (0.0-1.0) an otherwise-missed request "hits" via similarity to something already cached, once the store is completely full. Semantic mode only — see cachingMode. */
  semanticHitRate?: number;
  /** Distinct keys the cache can hold before it must evict something. */
  capacity?: number;
  /** Which entry to remove when a new key arrives at capacity. */
  evictionPolicy?: EvictionPolicy;
  /** How long an entry stays valid after being stored, in ms. 0 = never expires. */
  ttlMs?: number;
  /** Lookups/stores the cache can be actively handling at once. */
  maxConcurrent?: number;
  /** Requests allowed to wait once maxConcurrent is reached. */
  maxQueueLength?: number;
  /** Time to serve a hit, in ms — fast, since it's just a memory lookup. */
  hitTimeMs?: number;
  /** Extra bookkeeping time added on a miss, on top of whatever's downstream. */
  missOverheadMs?: number;
  /** How concurrent misses for the same key behave when a fetch for it is already in flight — see class doc. */
  stampedeMode?: CacheStampedeMode;
  /** Whether a confirmed "not found" result gets cached too — see class doc on cache penetration. */
  negativeCaching?: NegativeCachingMode;
  /** How long a cached "not found" stays valid, in ms. 0 = never expires once cached. Only meaningful when negativeCaching is "on". */
  negativeCacheTtlMs?: number;
  /** Randomizes each entry's own TTL by up to this fraction (0-0.5) above/below ttlMs — see class doc on cache avalanche. 0 = off. */
  ttlJitterPercent?: number;
}

const DEFAULTS: Required<CacheConfig> = {
  cachingMode: "exact",
  semanticHitRate: 0.7,
  capacity: 20,
  evictionPolicy: "lru",
  ttlMs: 0,
  maxConcurrent: 20,
  maxQueueLength: 100,
  hitTimeMs: 1,
  missOverheadMs: 1,
  stampedeMode: "naive",
  negativeCaching: "off",
  negativeCacheTtlMs: 2000,
  ttlJitterPercent: 0,
};

/** What a request's own in-flight slot resolves to: "hit" answers straight
 * from the positive cache, "negative_hit" answers straight from the
 * negative cache (a fast, local "not found" — see onArrival's short-circuit),
 * "miss" falls through downstream. Only meaningful for a request-direction
 * record — a response-direction record (storing a returned value) never
 * reads this back. */
type InFlightOutcome = "hit" | "negative_hit" | "miss";

interface InFlightRecord {
  meta: RequestLifecycleMetadata;
  /** Only meaningful when meta.direction === "request". */
  outcome: InFlightOutcome;
}

/** A miss that coalesced onto another in-flight fetch for the same key, waiting to be woken by that fetch's outcome. */
interface StampedeFollower {
  requestId: RequestId;
  meta: RequestLifecycleMetadata;
}

export class Cache implements Entity {
  readonly id: EntityId;

  private readonly config: Required<CacheConfig>;
  private readonly processor: BoundedProcessor;
  private readonly store: CacheStore;
  private readonly inFlight = new Map<RequestId, InFlightRecord>();
  /**
   * Keys with a fetch currently in flight under stampedeMode "coalesced".
   * Presence of a key here (even with an empty array) means "someone is
   * already fetching this — wait on them instead of fetching again."
   */
  private readonly stampedeInFlight = new Map<string, StampedeFollower[]>();
  /**
   * Keys confirmed not to exist, mapped to when that fact expires (0 =
   * never) — only populated/consulted when negativeCaching is "on". Kept
   * separate from `store` (the positive cache) rather than reusing it:
   * a "not found" isn't a value with the same capacity/eviction semantics,
   * and the two must never be confusable as the same entry.
   */
  private readonly negativeCache = new Map<string, number>();

  constructor(id: EntityId, config: CacheConfig = {}) {
    this.id = id;
    this.config = { ...DEFAULTS, ...config };
    this.processor = new BoundedProcessor(
      this.config.maxConcurrent,
      this.config.maxQueueLength
    );
    this.store = new CacheStore({
      capacity: this.config.capacity,
      evictionPolicy: this.config.evictionPolicy,
      ttlMs: this.config.ttlMs,
    });
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
    const isRequestLeg = meta.direction === "request";
    // Decide hit/miss (and touch the entry on a hit) now, at admission —
    // not when processing finishes — so a burst of identical keys
    // arriving back-to-back all see the same, already-warm cache state.
    const lookup = isRequestLeg ? this.store.lookup(meta.key, ctx.now) : "cold";
    const exactHit = lookup === "hit";
    const isExpiryMiss = lookup === "expired";
    const isPhantom = meta.exists === false;
    if (isRequestLeg && exactHit) this.store.touch(meta.key, ctx.now);

    // Semantic caching is additive on top of exact matching, never a
    // replacement for it — a repeat of the identical key still hits for
    // free either way, same as a real semantic cache. Only rolled on an
    // otherwise-missed request, and never for a phantom (confirmed
    // nonexistent) key — a fuzzy match to something that doesn't exist
    // isn't a coherent "semantic hit."
    const isSemanticHit =
      isRequestLeg &&
      !exactHit &&
      !isPhantom &&
      this.config.cachingMode === "semantic" &&
      this.rollSemanticHit(ctx);
    const hit = exactHit || isSemanticHit;

    // Negative-cache short-circuit: a key already confirmed not to exist,
    // with that confirmation still valid, is answered immediately and
    // locally — no stampede coalescing, no downstream trip at all. This is
    // exactly what negative caching buys over the naive default (see class
    // doc on cache penetration).
    if (isRequestLeg && !hit && isPhantom && this.config.negativeCaching === "on") {
      const negativeExpiresAt = this.negativeCache.get(meta.key);
      if (negativeExpiresAt !== undefined) {
        const stillValid = negativeExpiresAt === 0 || ctx.now < negativeExpiresAt;
        if (stillValid) {
          this.inFlight.set(requestId, { meta, outcome: "negative_hit" });
          const duration = Math.max(1, this.config.hitTimeMs + ctx.rng.nextInt(0, 2));
          return [
            createProcessingStartedEvent(ctx.now, this.id, requestId),
            createCacheAccessEvent("CACHE_MISS", ctx.now, this.id, requestId, meta.key, false, {
              negative: true,
              notFound: true,
            }),
            createProcessingCompletedEvent(ctx.now + duration, this.id, requestId),
          ];
        }
        // The negative entry itself has expired — treat this like any
        // other miss below, same as an expired positive entry would.
        this.negativeCache.delete(meta.key);
      }
    }

    if (isRequestLeg && !hit && this.config.stampedeMode === "coalesced") {
      const followers = this.stampedeInFlight.get(meta.key);
      if (followers) {
        // Another fetch for this key is already in flight — wait on it
        // instead of triggering a second one. This request keeps the
        // admitted slot processor.admit() already gave it (see class doc:
        // waiting still has a cost) until releaseStampedeFollowers wakes
        // it once the leader's fetch resolves.
        followers.push({ requestId, meta });
        return [
          createProcessingStartedEvent(ctx.now, this.id, requestId),
          createCacheAccessEvent(
            "CACHE_MISS",
            ctx.now,
            this.id,
            requestId,
            meta.key,
            false,
            { coalesced: true, ...(isPhantom ? { notFound: true } : {}) }
          ),
        ];
      }
      // First miss for this key — this request becomes its leader.
      // Registering the (empty, for now) follower list here, before the
      // fetch it's about to trigger even starts, is what lets the very
      // next concurrent miss for this key find it and wait instead.
      this.stampedeInFlight.set(meta.key, []);
    }

    const outcome: InFlightOutcome = hit ? "hit" : "miss";
    this.inFlight.set(requestId, { meta, outcome });

    const base = isRequestLeg
      ? hit
        ? this.config.hitTimeMs
        : this.config.missOverheadMs
      : this.config.hitTimeMs; // storing the fetched value on the way back is cheap too
    const duration = Math.max(1, base + ctx.rng.nextInt(0, 2));

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
          {
            ...(isExpiryMiss ? { expired: true } : {}),
            ...(isPhantom ? { notFound: true } : {}),
            ...(isSemanticHit ? { semantic: true } : {}),
          }
        )
      );
    }
    events.push(
      createProcessingCompletedEvent(ctx.now + duration, this.id, requestId)
    );
    return events;
  }

  /** Semantic caching only — see CacheConfig.cachingMode. Scales semanticHitRate by how full the store currently is: an empty store has nothing to be similar to (0% chance), a full one reaches the configured ceiling. */
  private rollSemanticHit(ctx: SimulationContext): boolean {
    const fullness = Math.max(0, Math.min(1, this.store.size / this.config.capacity));
    return ctx.rng.next() < this.config.semanticHitRate * fullness;
  }

  /** Randomizes ttlMs by up to ±ttlJitterPercent for one entry, so a batch
   * of entries cached around the same time don't all share one exact
   * expiry — see class doc on cache avalanche. Returns undefined (meaning
   * "use CacheStore's own configured TTL") whenever jitter isn't in play,
   * so callers don't need their own off/on branch. */
  private jitteredTtlMs(ctx: SimulationContext): number | undefined {
    if (this.config.ttlMs <= 0 || this.config.ttlJitterPercent <= 0) return undefined;
    const spread = (ctx.rng.next() * 2 - 1) * this.config.ttlJitterPercent; // in [-jitter, +jitter)
    return Math.max(1, Math.round(this.config.ttlMs * (1 + spread)));
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
          nextQueued.metadata as RequestLifecycleMetadata,
          ctx
        )
      );
    }

    if (!record) return events;
    const { meta, outcome } = record;

    if (meta.direction === "request") {
      if (outcome === "hit") {
        events.push(...this.respond(meta, ctx, event.requestId));
        return events;
      }
      if (outcome === "negative_hit") {
        events.push(
          ...this.respond(
            { ...meta, failed: true, failureReason: "not_found" },
            ctx,
            event.requestId
          )
        );
        return events;
      }

      const target = ctx.downstream[0];
      if (!target) {
        events.push(...this.fail(meta, ctx, event.requestId, "no_downstream_connection"));
        // This leader never actually got to fetch — anyone who coalesced
        // onto it in the meantime shares the same local failure.
        events.push(
          ...this.releaseStampedeFollowers(meta.key, ctx, true, "no_downstream_connection")
        );
        return events;
      }
      const latency = ctx.latencyTo(target);
      events.push(
        createRequestRoutedEvent(
          ctx.now + latency,
          this.id,
          target,
          event.requestId,
          { ...meta, direction: "request", path: [...meta.path, this.id] }
        )
      );
    } else {
      // The value we missed on has come back from downstream. A request
      // tagged as targeting a nonexistent key resolves deterministically
      // to "not found" here regardless of what downstream itself reported
      // — this engine's downstream entities have no concept of per-key
      // existence, so Cache is the one place that knows (see class doc on
      // cache penetration).
      const isPhantom = meta.exists === false;
      const failed = meta.failed === true || isPhantom;
      const failureReason = isPhantom ? "not_found" : meta.failureReason;

      if (!failed) {
        // Only when it actually succeeded: a failed downstream fetch has
        // nothing worth caching.
        this.store.set(meta.key, ctx.now, this.jitteredTtlMs(ctx));
      } else if (isPhantom && this.config.negativeCaching === "on") {
        const expiresAt =
          this.config.negativeCacheTtlMs > 0 ? ctx.now + this.config.negativeCacheTtlMs : 0;
        this.negativeCache.set(meta.key, expiresAt);
      }

      const responseMeta: RequestLifecycleMetadata = isPhantom
        ? { ...meta, failed: true, failureReason: "not_found" }
        : meta;
      events.push(...this.respond(responseMeta, ctx, event.requestId));
      events.push(...this.releaseStampedeFollowers(meta.key, ctx, failed, failureReason));
    }

    return events;
  }

  /**
   * Wakes every request that coalesced onto `key`'s now-finished fetch,
   * handing each one the same outcome the leader got — the value that
   * just got cached, or the same failure. Frees each follower's admitted
   * slot in turn via processor.complete(), same as any other completion,
   * which can itself dequeue further backlogged work.
   */
  private releaseStampedeFollowers(
    key: string,
    ctx: SimulationContext,
    failed: boolean,
    failureReason?: string
  ): SimulationEvent[] {
    const followers = this.stampedeInFlight.get(key);
    this.stampedeInFlight.delete(key);
    if (!followers || followers.length === 0) return [];

    const events: SimulationEvent[] = [];
    for (const follower of followers) {
      const followerMeta: RequestLifecycleMetadata = failed
        ? { ...follower.meta, failed: true, failureReason: failureReason ?? "unknown" }
        : follower.meta;
      events.push(...this.respond(followerMeta, ctx, follower.requestId));

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
