/**
 * The MessageQueue buffers work between a producer and one or more
 * downstream consumers, so producer and consumer can run at different
 * speeds — and, depending on `deliveryMode`, so a message can reach
 * either exactly one consumer or every subscriber.
 *
 * ENTITIES.md doesn't document this entity; entityEducation.ts already
 * states its intended lesson — "producers don't wait on consumers" and
 * "accepted the request" is a different moment from "finished the
 * request." That's the one real behavioral difference from
 * APIServer/Database/Cache: every other bounded-capacity entity replies
 * only once a request has been fully handled *and* forwarded onward if
 * needed. A queue replies the instant a message is durably admitted, then
 * dispatches to its downstream consumer(s) as an entirely separate,
 * self-contained request under the same requestId — same visual packet,
 * decoupled outcome.
 *
 * `deliveryMode` is the point-to-point-vs-pub/sub distinction the course
 * treats as two architecturally different tools (LEARNING-PARITY.md: the
 * largest gap found in that audit), modeled as a comparable config axis
 * the same way Load Balancer ships comparable algorithms:
 *
 * - "queue" (point-to-point, the default — unchanged from before this
 *   config existed): a single shared consumer pool (`consumerCount`
 *   workers, one `maxQueueLength` backlog) competes for each message.
 *   Only `ctx.downstream[0]` ever receives anything, and each message
 *   goes to exactly one consumer — a classic task queue. Admission is
 *   gated by that shared backlog: a producer can be rejected outright if
 *   it's full.
 * - "topic" (fan-out/pub-sub): every entry in `ctx.downstream` is an
 *   independent subscriber with its *own* consumer pool (sized by the
 *   same consumerCount/maxQueueLength config, simplification: not
 *   configured per-subscriber) — every subscriber gets its own copy of
 *   every message. Admission to the topic itself is never gated by any
 *   subscriber's backlog (there's no shared backlog to overflow — the
 *   core decoupling pub/sub buys over point-to-point); a slow subscriber
 *   only ever drops its own copy, and never blocks or fails the publish
 *   or any other subscriber. This is also why fan-out multiplies
 *   dispatch load by subscriber count for the same producer rate — a
 *   topic backs up much faster than a queue would unless capacity is
 *   sized for that.
 *
 * That second, queue-originated leg (per subscriber, under topic mode) is
 * a real simulated request/response (so a downstream API Server or
 * Database reacts to it exactly as it would to anything else — full
 * capacity checks, real latency), which means it also ends in a genuine
 * REQUEST_COMPLETED/REQUEST_FAILED, just addressed back to this queue
 * instead of a client. MetricsCollector's `clientIds` filter is what keeps
 * that from double-counting against the client-facing totals — see its
 * comment for why. Reusing the original requestId across every
 * subscriber's independent leg is safe: nothing in this codebase — engine,
 * metrics, or playback — assumes a requestId names a single in-flight leg;
 * every entity only reasons about the event actually in front of it
 * (Local Knowledge).
 *
 * Learning goal: backpressure doesn't have to mean "reject immediately."
 * A queue trades that for "reject only once the buffer itself is full,"
 * absorbing bursts a downstream consumer alone couldn't keep up with —
 * at the cost of the consumer seeing work later than the producer sent it.
 * A topic goes further: it doesn't even share one buffer to fill, trading
 * "one backlog to reason about" for "every subscriber's lag is now its
 * own separate concern."
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

export type MessageQueueDeliveryMode = "queue" | "topic";

export interface MessageQueueConfig {
  /** Consumers pulling messages off the backlog at once (per subscriber, under "topic"). */
  consumerCount?: number;
  /** Messages a backlog can buffer once every consumer is busy, before rejecting new ones (per subscriber, under "topic"). */
  maxQueueLength?: number;
  /** Time a consumer takes to pick up and hand off one message, in ms. */
  dispatchTimeMs?: number;
  /** Random +/- jitter applied to dispatchTimeMs, in ms. */
  dispatchJitterMs?: number;
  /** "queue": point-to-point, one consumer per message. "topic": fan-out — every downstream subscriber gets every message. See class doc. */
  deliveryMode?: MessageQueueDeliveryMode;
}

const DEFAULTS: Required<MessageQueueConfig> = {
  consumerCount: 3,
  maxQueueLength: 500,
  dispatchTimeMs: 10,
  dispatchJitterMs: 3,
  deliveryMode: "queue",
};

/** What's needed to dispatch a message once a consumer is free for it — "queue" mode. */
interface PendingDispatch {
  key: string;
}

/**
 * Same idea, for one subscriber's independent dispatch of one message
 * under "topic" mode. Tracked under a synthetic `${requestId}::${target}`
 * key rather than the bare requestId, since under fan-out the same
 * original requestId is dispatching to several subscribers at once —
 * this key only ever exists inside this entity, never on an emitted event
 * another entity sees.
 */
interface PendingTopicDispatch {
  key: string;
  target: EntityId;
  requestId: RequestId;
}

export class MessageQueue implements Entity {
  readonly id: EntityId;

  private readonly config: Required<MessageQueueConfig>;

  // ---- "queue" (point-to-point) state — unchanged from before "topic" existed ----
  private readonly processor: BoundedProcessor;
  private readonly dispatching = new Map<RequestId, PendingDispatch>();

  // ---- "topic" (fan-out) state — one independent consumer pool per subscriber ----
  private readonly topicProcessors = new Map<EntityId, BoundedProcessor>();
  private readonly topicDispatching = new Map<string, PendingTopicDispatch>();

  constructor(id: EntityId, config: MessageQueueConfig = {}) {
    this.id = id;
    this.config = { ...DEFAULTS, ...config };
    this.processor = new BoundedProcessor(
      this.config.consumerCount,
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
      return this.config.deliveryMode === "topic"
        ? this.onTopicDispatchComplete(event, ctx)
        : this.onDispatchComplete(event, ctx);
    }
    // A queue-originated dispatch's own REQUEST_COMPLETED/REQUEST_FAILED
    // also lands here (addressed to this.id, see class doc) — nothing
    // left to do with it, the producer was already acknowledged.
    return [];
  }

  private onArrival(
    event: SimulationEvent,
    ctx: SimulationContext
  ): SimulationEvent[] {
    if (!event.requestId) return [];
    const meta = event.metadata as RequestLifecycleMetadata;

    if (this.config.deliveryMode === "topic") {
      return this.onTopicArrival(event.requestId, meta, ctx);
    }

    const result = this.processor.admit(event);
    if (result === "rejected") {
      return [
        createQueueFullEvent(ctx.now, this.id, event.requestId),
        ...this.fail(meta, ctx, event.requestId, "queue_full"),
      ];
    }

    // Admitted — durably accepted, so the producer is done waiting right
    // here, regardless of whether a consumer is free yet.
    const events: SimulationEvent[] = this.acknowledge(meta, ctx, event.requestId);

    if (result === "queued") {
      events.push(createRequestQueuedEvent(ctx.now, this.id, event.requestId));
      return events;
    }

    events.push(...this.beginDispatch(event.requestId, meta.key, ctx));
    return events;
  }

  /** Replies up the original path immediately — the producer never waits for a consumer. */
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

  /** Routes a local failure via findResponseTarget instead of straight to the client — see Database.ts's identical helper. */
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

  private beginDispatch(
    requestId: RequestId,
    key: string,
    ctx: SimulationContext
  ): SimulationEvent[] {
    this.dispatching.set(requestId, { key });
    const jitter = ctx.rng.nextInt(
      -this.config.dispatchJitterMs,
      this.config.dispatchJitterMs + 1
    );
    const duration = Math.max(1, this.config.dispatchTimeMs + jitter);

    return [
      createProcessingStartedEvent(ctx.now, this.id, requestId),
      createProcessingCompletedEvent(ctx.now + duration, this.id, requestId),
    ];
  }

  private onDispatchComplete(
    event: SimulationEvent,
    ctx: SimulationContext
  ): SimulationEvent[] {
    if (!event.requestId) return [];
    const pending = this.dispatching.get(event.requestId);
    this.dispatching.delete(event.requestId);

    const events: SimulationEvent[] = [];

    const nextQueued = this.processor.complete();
    if (nextQueued && nextQueued.requestId) {
      const nextMeta = nextQueued.metadata as RequestLifecycleMetadata;
      events.push(createRequestDequeuedEvent(ctx.now, this.id, nextQueued.requestId));
      events.push(...this.beginDispatch(nextQueued.requestId, nextMeta.key, ctx));
    }

    if (!pending) return events;

    const target = ctx.downstream[0];
    if (!target) {
      // Nothing to deliver to — the producer's already been acknowledged,
      // so this is purely this queue's own local problem (Observable
      // Behavior: still worth surfacing on its own error count).
      events.push(
        createRequestFailedEvent(
          ctx.now,
          this.id,
          this.id,
          event.requestId,
          "no_downstream_connection"
        )
      );
      return events;
    }

    // A fresh, independent request/response chain rooted at this queue —
    // same requestId (so playback shows one continuous packet), but its
    // own path, so downstream's eventual REQUEST_COMPLETED/FAILED comes
    // back here, not to the original producer (see class doc).
    const latency = ctx.latencyTo(target);
    events.push(
      createRequestRoutedEvent(ctx.now + latency, this.id, target, event.requestId, {
        startedAt: ctx.now,
        direction: "request",
        path: [this.id],
        key: pending.key,
      })
    );
    return events;
  }

  // ---- "topic" (fan-out/pub-sub) — every downstream connection is an independent subscriber ----

  /**
   * A topic durably accepts a publish regardless of any subscriber's
   * readiness — there's no shared backlog to overflow, which is the core
   * decoupling pub/sub buys over point-to-point. The producer is
   * acknowledged exactly the same way "queue" mode does it, then each
   * subscriber is offered its own independent copy.
   */
  private onTopicArrival(
    requestId: RequestId,
    meta: RequestLifecycleMetadata,
    ctx: SimulationContext
  ): SimulationEvent[] {
    const events: SimulationEvent[] = this.acknowledge(meta, ctx, requestId);

    const subscribers = ctx.downstream;
    if (subscribers.length === 0) {
      // Same reasoning as "queue" mode's no-downstream case: purely this
      // queue's own local problem, since the producer's already acked.
      events.push(
        createRequestFailedEvent(ctx.now, this.id, this.id, requestId, "no_downstream_connection")
      );
      return events;
    }

    for (const target of subscribers) {
      events.push(...this.admitTopicDispatch(requestId, meta.key, target, ctx));
    }
    return events;
  }

  /** Lazily creates and reuses one subscriber's own consumer pool — independent of every other subscriber's. */
  private topicProcessorFor(target: EntityId): BoundedProcessor {
    let processor = this.topicProcessors.get(target);
    if (!processor) {
      processor = new BoundedProcessor(this.config.consumerCount, this.config.maxQueueLength);
      this.topicProcessors.set(target, processor);
    }
    return processor;
  }

  private admitTopicDispatch(
    requestId: RequestId,
    key: string,
    target: EntityId,
    ctx: SimulationContext
  ): SimulationEvent[] {
    const processor = this.topicProcessorFor(target);
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
      // This one subscriber fell too far behind to keep up — its own
      // local problem (Observable Behavior: still worth surfacing), never
      // the producer's: it was acknowledged before any subscriber was
      // even considered.
      return [createQueueFullEvent(ctx.now, this.id, dispatchId, { subscriber: target })];
    }
    if (result === "queued") {
      return [createRequestQueuedEvent(ctx.now, this.id, dispatchId, { subscriber: target })];
    }
    return this.beginTopicDispatch(dispatchId, requestId, key, target, ctx);
  }

  private beginTopicDispatch(
    dispatchId: string,
    requestId: RequestId,
    key: string,
    target: EntityId,
    ctx: SimulationContext
  ): SimulationEvent[] {
    this.topicDispatching.set(dispatchId, { key, target, requestId });
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

  private onTopicDispatchComplete(
    event: SimulationEvent,
    ctx: SimulationContext
  ): SimulationEvent[] {
    if (!event.requestId) return [];
    const pending = this.topicDispatching.get(event.requestId);
    this.topicDispatching.delete(event.requestId);
    if (!pending) return [];

    const events: SimulationEvent[] = [];

    const processor = this.topicProcessorFor(pending.target);
    const nextQueued = processor.complete();
    if (nextQueued && nextQueued.requestId) {
      const nextMeta = nextQueued.metadata as { key: string; requestId: RequestId };
      events.push(
        createRequestDequeuedEvent(ctx.now, this.id, nextQueued.requestId, {
          subscriber: pending.target,
        })
      );
      events.push(
        ...this.beginTopicDispatch(
          nextQueued.requestId,
          nextMeta.requestId,
          nextMeta.key,
          pending.target,
          ctx
        )
      );
    }

    // Deliver this subscriber's copy — its own independent request/response
    // chain, same requestId as the original publish (see class doc: no
    // engine invariant depends on a requestId naming a single leg).
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
