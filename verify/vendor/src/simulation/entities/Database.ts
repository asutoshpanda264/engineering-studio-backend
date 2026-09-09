/**
 * The Database executes queries against a bounded connection pool.
 *
 * ENTITIES.md doesn't document this entity in detail (only Client is
 * fully written up) — this behavior fills that gap using the config
 * fields TECHNICAL-SPECIFICATION.md sketches for it directly: Maximum
 * Connections, Processing Time, Failure Probability.
 *
 * The Database is the end of the request leg for this simple pipeline:
 * on success it responds to whichever entity sent it the query (the
 * immediately preceding hop in `path`, not necessarily the client
 * directly); on failure it fails straight back to the client, since
 * there's no partial response to generate.
 *
 * `type` (sql | nosql) applies a fixed multiplier on top of whatever
 * Max Connections / Processing Time the user configured, rather than
 * changing those fields' own defaults — the Inspector shows exactly what
 * was typed in either way, the same way it already shows a processing
 * time that jitter then adjusts at simulation time; type is one more
 * layer applied on top, not a hidden second set of defaults the UI would
 * silently disagree with. SQL's multipliers are both 1 (identical to
 * today's behavior, and the default, so no existing scenario's numbers
 * shift); NoSQL scales the effective connection ceiling up and the
 * effective query time down, standing in for horizontal partitioning and
 * simpler key-based access relative to a relational engine's query
 * planning/locking overhead.
 *
 * This does not model schemas, joins, partition keys, replication, or
 * consistency (ACID vs eventual) — those need query-shape and
 * data-versioning modeling this engine doesn't have. What's modeled is
 * only the aggregate throughput/latency consequence, at the level this
 * engine already simulates: bounded concurrency and per-query time.
 *
 * Learning goal: a database is a shared, limited resource — every
 * query it runs concurrently competes for the same connection pool,
 * and it can fail independently of anything upstream. SQL vs NoSQL is a
 * design tradeoff, not a strict upgrade — NoSQL's higher throughput here
 * comes with consistency guarantees this simulation doesn't check, which
 * is exactly the tradeoff a real choice between them involves.
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
  createDatabaseBusyEvent,
  createProcessingCompletedEvent,
  createProcessingStartedEvent,
  createRequestCompletedEvent,
  createRequestDequeuedEvent,
  createRequestFailedEvent,
  createRequestQueuedEvent,
  createRequestRoutedEvent,
} from "../events/EventFactory";

export type DatabaseType = "sql" | "nosql";

export interface DatabaseConfig {
  /** Relational (bounded connection pool, query-planning overhead) or
   * document/key-value (partitioned, simpler access). See class doc. */
  type?: DatabaseType;
  /** Concurrent queries the connection pool allows. */
  maxConnections?: number;
  /** Queries allowed to wait once maxConnections is reached. */
  maxQueueLength?: number;
  /** Base time to execute a query, in ms. */
  processingTimeMs?: number;
  /** Random +/- jitter applied to processingTimeMs, in ms. */
  processingJitterMs?: number;
  /** Chance (0.0-1.0) a query fails independently of load. */
  failureProbability?: number;
}

const DEFAULTS: Required<DatabaseConfig> = {
  type: "sql",
  maxConnections: 5,
  maxQueueLength: 100,
  processingTimeMs: 15,
  processingJitterMs: 5,
  failureProbability: 0,
};

interface TypeProfile {
  /** Multiplies the configured connection ceiling. */
  concurrencyMultiplier: number;
  /** Multiplies the configured processing time (and its jitter). */
  latencyMultiplier: number;
}

/** sql is 1x/1x on purpose — identical to this entity's behavior before
 * `type` existed, so no scenario or test built against the old flat
 * defaults shifts underneath it. */
const TYPE_PROFILE: Record<DatabaseType, TypeProfile> = {
  sql: { concurrencyMultiplier: 1, latencyMultiplier: 1 },
  nosql: { concurrencyMultiplier: 3, latencyMultiplier: 0.5 },
};

export class Database implements Entity {
  readonly id: EntityId;

  private readonly config: Required<DatabaseConfig>;
  private readonly profile: TypeProfile;
  private readonly processor: BoundedProcessor;
  private readonly inFlight = new Map<RequestId, RequestLifecycleMetadata>();

  constructor(id: EntityId, config: DatabaseConfig = {}) {
    this.id = id;
    this.config = { ...DEFAULTS, ...config };
    this.profile = TYPE_PROFILE[this.config.type];
    this.processor = new BoundedProcessor(
      Math.max(1, Math.round(this.config.maxConnections * this.profile.concurrencyMultiplier)),
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
        createDatabaseBusyEvent(ctx.now, this.id, event.requestId),
        ...this.fail(meta, ctx, event.requestId, "database_busy"),
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
    const duration = Math.max(
      1,
      Math.round((this.config.processingTimeMs + jitter) * this.profile.latencyMultiplier)
    );

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

    const failed = ctx.rng.next() < this.config.failureProbability;
    if (failed) {
      events.push(...this.fail(meta, ctx, event.requestId, "query_failed"));
      return events;
    }

    // Respond to whoever sent the query — see responseRouting.ts. If
    // that's the client directly (no hops in between), this must be the
    // terminal REQUEST_COMPLETED: Client only reacts to REQUEST_STARTED,
    // so a REQUEST_ROUTED here would go unrecognized and the request would
    // silently vanish with no metrics.
    const { target, isClient } = findResponseTarget(this.id, meta.path);
    if (isClient) {
      const duration = ctx.now - meta.startedAt;
      events.push(
        createRequestCompletedEvent(
          ctx.now,
          this.id,
          target,
          event.requestId,
          duration
        )
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
        {
          ...meta,
          direction: "response",
          path: meta.path,
        }
      )
    );

    return events;
  }

  /**
   * Routes a failure back exactly like a successful response — via
   * findResponseTarget, one hop at a time — instead of jumping straight to
   * the client. This is what lets anything sitting between here and the
   * client (a Circuit Breaker deciding whether to trip, a Load Balancer
   * updating its own in-flight count) actually observe that this request
   * failed, rather than the failure silently skipping past them.
   */
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
