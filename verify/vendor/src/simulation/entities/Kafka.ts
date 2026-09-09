/**
 * Kafka is Message Queue's fan-out (Topic) mode built on a genuinely
 * different storage model — the distinction LEARNING-PARITY.md concluded
 * deserved its own entity rather than a third `deliveryMode`: a
 * partitioned, durable log with independent consumer-group offsets,
 * instead of a transient in-memory buffer.
 *
 * **Partitions.** The topic is split into `partitionCount` partitions. A
 * message's partition is `hashStringToIndex(key, partitionCount)` — the
 * same deterministic hash CDN uses for key→edge and Load Balancer's IP
 * Hash uses for key→target — so every message for a given key always
 * lands in the same partition. That's Kafka's real ordering guarantee
 * made concrete: strict order *within* a partition (same key, same
 * partition, arrives in order), no ordering promise *across* partitions.
 * Emitted as a PARTITION_ASSIGNED marker at admission (destination null,
 * same as CACHE_HIT/MISS — a diagnostic event, never delivered anywhere),
 * independent of whether any consumer group exists yet, exactly like a
 * real produce-to-log write.
 *
 * **Consumer groups.** Every downstream connection is an independent
 * consumer group — same fan-out shape as Message Queue's Topic mode, each
 * with its own consumer pool and backlog. What's different: a group's
 * *useful* parallelism is capped at `min(consumerCountPerGroup,
 * partitionCount)` — a sixth consumer in a group reading a 4-partition
 * topic has nothing to do, the single most commonly cited Kafka fact this
 * is built specifically to make failable-and-observable. Independent of
 * that cap, the producer is acknowledged the instant a message is
 * admitted to the log — never gated on any consumer group's readiness,
 * the same decoupling Message Queue's Topic mode already has, stronger
 * here since there's no shared backlog to overflow at all, only each
 * group's own.
 *
 * **What's deliberately not simulated.** Every consumer group configured
 * on the graph exists from the start of the run and reads the live
 * stream — there's no "add a group later, replay from offset 0" here,
 * since this engine has no notion of a group joining mid-simulation with
 * a different starting position. A group that falls too far behind (its
 * own backlog fills) has that dispatch rejected — a bounded-buffer stand-
 * in for unbounded consumer lag against a retention window, the same
 * simplification Message Queue's maxQueueLength already makes for
 * backpressure. Replay and true unbounded retention aren't modeled.
 *
 * Learning goal: partitions are what make a distributed log *ordered
 * where it needs to be and parallel everywhere else* — a single
 * partition count decision trades those against each other for every
 * consumer group at once, not per-group.
 */

import type { Entity, SimulationContext } from "./Entity";
import type { EntityId, RequestId } from "../types";
import type {
  RequestLifecycleMetadata,
  SimulationEvent,
} from "../events/types";
import { BoundedProcessor } from "./BoundedProcessor";
import { findResponseTarget } from "./responseRouting";
import { hashStringToIndex } from "./hashRouting";
import {
  createPartitionAssignedEvent,
  createProcessingCompletedEvent,
  createProcessingStartedEvent,
  createQueueFullEvent,
  createRequestCompletedEvent,
  createRequestDequeuedEvent,
  createRequestFailedEvent,
  createRequestQueuedEvent,
  createRequestRoutedEvent,
} from "../events/EventFactory";

export interface KafkaConfig {
  /** How many partitions the topic is split into. */
  partitionCount?: number;
  /** Consumers each consumer group runs. Effective parallelism per group is capped at partitionCount — see class doc. */
  consumerCountPerGroup?: number;
  /** Messages a group's backlog can buffer once every one of its consumers is busy, before rejecting new ones. */
  maxQueueLength?: number;
  /** Time a consumer takes to pick up and hand off one message, in ms. */
  dispatchTimeMs?: number;
  /** Random +/- jitter applied to dispatchTimeMs, in ms. */
  dispatchJitterMs?: number;
}

const DEFAULTS: Required<KafkaConfig> = {
  partitionCount: 3,
  consumerCountPerGroup: 3,
  maxQueueLength: 500,
  dispatchTimeMs: 10,
  dispatchJitterMs: 3,
};

/** One consumer group's independent dispatch of one message — key is `${requestId}::${target}`, since the same requestId fans out to every group at once. */
interface PendingGroupDispatch {
  key: string;
  target: EntityId;
  requestId: RequestId;
}

export class Kafka implements Entity {
  readonly id: EntityId;

  private readonly config: Required<KafkaConfig>;
  /** One independent consumer pool per consumer group (downstream target). */
  private readonly groupProcessors = new Map<EntityId, BoundedProcessor>();
  private readonly groupDispatching = new Map<string, PendingGroupDispatch>();

  constructor(id: EntityId, config: KafkaConfig = {}) {
    this.id = id;
    this.config = { ...DEFAULTS, ...config };
  }

  handleEvent(
    event: SimulationEvent,
    ctx: SimulationContext
  ): SimulationEvent[] {
    if (event.type === "REQUEST_ROUTED" && event.destination === this.id) {
      return this.onArrival(event, ctx);
    }
    if (event.type === "PROCESSING_COMPLETED" && event.destination === this.id) {
      return this.onGroupDispatchComplete(event, ctx);
    }
    // A group-originated dispatch's own REQUEST_COMPLETED/REQUEST_FAILED
    // also lands here (addressed to this.id) — nothing left to do with
    // it, the producer was already acknowledged at admission.
    return [];
  }

  private onArrival(
    event: SimulationEvent,
    ctx: SimulationContext
  ): SimulationEvent[] {
    if (!event.requestId) return [];
    const meta = event.metadata as RequestLifecycleMetadata;

    // A produce-to-log write: always durably admitted, independent of any
    // consumer group's state, and recorded regardless of whether a
    // consumer group is even connected yet — see class doc.
    const partitionIndex = hashStringToIndex(meta.key, this.config.partitionCount);
    const events: SimulationEvent[] = [
      createPartitionAssignedEvent(ctx.now, this.id, event.requestId, partitionIndex, meta.key),
      ...this.acknowledge(meta, ctx, event.requestId),
    ];

    const groups = ctx.downstream;
    if (groups.length === 0) {
      events.push(
        createRequestFailedEvent(ctx.now, this.id, this.id, event.requestId, "no_downstream_connection")
      );
      return events;
    }

    for (const target of groups) {
      events.push(...this.admitGroupDispatch(event.requestId, meta.key, target, ctx));
    }
    return events;
  }

  /** Replies up the original path immediately — the producer never waits for any consumer group. */
  private acknowledge(
    meta: RequestLifecycleMetadata,
    ctx: SimulationContext,
    requestId: RequestId
  ): SimulationEvent[] {
    const { target, isClient } = findResponseTarget(this.id, meta.path);
    if (isClient) {
      const duration = ctx.now - meta.startedAt;
      return [
        createRequestCompletedEvent(ctx.now, this.id, target, requestId, duration),
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

  /** Lazily creates and reuses one group's own consumer pool, sized by its capped effective parallelism — independent of every other group's. */
  private groupProcessorFor(target: EntityId): BoundedProcessor {
    let processor = this.groupProcessors.get(target);
    if (!processor) {
      // A group's useful parallelism can never exceed the partition count
      // — extra consumers beyond that have no partition left to read.
      const effectiveConcurrency = Math.max(
        1,
        Math.min(this.config.consumerCountPerGroup, this.config.partitionCount)
      );
      processor = new BoundedProcessor(effectiveConcurrency, this.config.maxQueueLength);
      this.groupProcessors.set(target, processor);
    }
    return processor;
  }

  private admitGroupDispatch(
    requestId: RequestId,
    key: string,
    target: EntityId,
    ctx: SimulationContext
  ): SimulationEvent[] {
    const processor = this.groupProcessorFor(target);
    const dispatchId = `${requestId}::${target}`;
    // A placeholder token, never emitted — BoundedProcessor only ever
    // hands back exactly what it was given, so this is purely a way to
    // carry {key, requestId} through to the eventual dequeue.
    const placeholder = createRequestRoutedEvent(ctx.now, this.id, target, dispatchId, {
      key,
      requestId,
    });
    const result = processor.admit(placeholder);

    if (result === "rejected") {
      // This group fell too far behind to keep up — its own local
      // problem (Observable Behavior: still worth surfacing), never the
      // producer's: it was acknowledged before any group was considered.
      return [createQueueFullEvent(ctx.now, this.id, dispatchId, { group: target })];
    }
    if (result === "queued") {
      return [createRequestQueuedEvent(ctx.now, this.id, dispatchId, { group: target })];
    }
    return this.beginGroupDispatch(dispatchId, requestId, key, target, ctx);
  }

  private beginGroupDispatch(
    dispatchId: string,
    requestId: RequestId,
    key: string,
    target: EntityId,
    ctx: SimulationContext
  ): SimulationEvent[] {
    this.groupDispatching.set(dispatchId, { key, target, requestId });
    const jitter = ctx.rng.nextInt(
      -this.config.dispatchJitterMs,
      this.config.dispatchJitterMs + 1
    );
    const duration = Math.max(1, this.config.dispatchTimeMs + jitter);

    return [
      createProcessingStartedEvent(ctx.now, this.id, dispatchId),
      createProcessingCompletedEvent(ctx.now + duration, this.id, dispatchId),
    ];
  }

  private onGroupDispatchComplete(
    event: SimulationEvent,
    ctx: SimulationContext
  ): SimulationEvent[] {
    if (!event.requestId) return [];
    const pending = this.groupDispatching.get(event.requestId);
    this.groupDispatching.delete(event.requestId);
    if (!pending) return [];

    const events: SimulationEvent[] = [];

    const processor = this.groupProcessorFor(pending.target);
    const nextQueued = processor.complete();
    if (nextQueued && nextQueued.requestId) {
      const nextMeta = nextQueued.metadata as { key: string; requestId: RequestId };
      events.push(
        createRequestDequeuedEvent(ctx.now, this.id, nextQueued.requestId, {
          group: pending.target,
        })
      );
      events.push(
        ...this.beginGroupDispatch(
          nextQueued.requestId,
          nextMeta.requestId,
          nextMeta.key,
          pending.target,
          ctx
        )
      );
    }

    // Deliver this group's copy — its own independent request/response
    // chain, same requestId as the original publish.
    const latency = ctx.latencyTo(pending.target);
    events.push(
      createRequestRoutedEvent(ctx.now + latency, this.id, pending.target, pending.requestId, {
        startedAt: ctx.now,
        direction: "request",
        path: [this.id],
        key: pending.key,
      })
    );
    return events;
  }
}
