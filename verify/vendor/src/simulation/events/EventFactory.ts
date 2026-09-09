/**
 * Factory functions for creating simulation events.
 *
 * Centralizing event creation ensures every event has the required fields
 * and makes it easy to add validation or defaults later.
 *
 * All events are immutable by construction.
 */

import type {
  SimulationEvent,
  EventType,
  EntityId,
  RequestId,
  Timestamp,
} from "./types";

let _eventIdCounter = 0;

/**
 * Generates a monotonically increasing event ID.
 * Not random — just ensures uniqueness within a run.
 */
function generateEventId(): string {
  return `evt_${++_eventIdCounter}`;
}

/**
 * Resets the counter (used between simulation runs for determinism).
 */
export function resetEventIds(): void {
  _eventIdCounter = 0;
}

/**
 * Creates a new immutable simulation event.
 */
export function createEvent(
  type: EventType,
  timestamp: Timestamp,
  source: EntityId | null,
  destination: EntityId | null,
  requestId: RequestId | null,
  metadata: Record<string, unknown> = {}
): SimulationEvent {
  return Object.freeze({
    id: generateEventId(),
    timestamp,
    type,
    source,
    destination,
    requestId,
    metadata,
  });
}

/**
 * Creates a request-started event. Destination defaults to the client
 * itself, since the Client entity is the one that reacts to it (routing
 * the new request downstream) — the simulator dispatches every event by
 * its `destination`.
 */
export function createRequestStartedEvent(
  timestamp: Timestamp,
  clientId: EntityId,
  requestId: RequestId,
  metadata: Record<string, unknown> = {}
): SimulationEvent {
  return createEvent(
    "REQUEST_STARTED",
    timestamp,
    clientId,
    clientId,
    requestId,
    metadata
  );
}

/**
 * Creates a request-routed event — a request or response arriving at the
 * next hop in the architecture. Reused for every hop (request leg and
 * response leg); `metadata.direction` distinguishes the two.
 */
export function createRequestRoutedEvent(
  timestamp: Timestamp,
  source: EntityId,
  destination: EntityId,
  requestId: RequestId,
  metadata: Record<string, unknown> = {}
): SimulationEvent {
  return createEvent(
    "REQUEST_ROUTED",
    timestamp,
    source,
    destination,
    requestId,
    metadata
  );
}

/**
 * Creates a request-completed event, delivered to the client that
 * originated the request.
 */
export function createRequestCompletedEvent(
  timestamp: Timestamp,
  sourceId: EntityId,
  destination: EntityId | null,
  requestId: RequestId,
  duration: number,
  metadata: Record<string, unknown> = {}
): SimulationEvent {
  return createEvent(
    "REQUEST_COMPLETED",
    timestamp,
    sourceId,
    destination,
    requestId,
    { duration, ...metadata }
  );
}

/**
 * Creates a processing-started event — an entity has begun doing bounded
 * capacity work (an API handler running, a database executing a query).
 */
export function createProcessingStartedEvent(
  timestamp: Timestamp,
  entityId: EntityId,
  requestId: RequestId,
  metadata: Record<string, unknown> = {}
): SimulationEvent {
  return createEvent(
    "PROCESSING_STARTED",
    timestamp,
    entityId,
    entityId,
    requestId,
    metadata
  );
}

/**
 * Creates a processing-completed event — an entity finished the work it
 * started with createProcessingStartedEvent. Self-addressed: it's how an
 * entity schedules its own future "I'm done" wake-up in a discrete-event
 * loop that only reacts to delivered events.
 */
export function createProcessingCompletedEvent(
  timestamp: Timestamp,
  entityId: EntityId,
  requestId: RequestId,
  metadata: Record<string, unknown> = {}
): SimulationEvent {
  return createEvent(
    "PROCESSING_COMPLETED",
    timestamp,
    entityId,
    entityId,
    requestId,
    metadata
  );
}

/**
 * Creates a request-queued event — an entity accepted work into its bounded
 * backlog because it was already at capacity. Self-addressed, same as
 * PROCESSING_STARTED, since it's the entity's own admission decision.
 */
export function createRequestQueuedEvent(
  timestamp: Timestamp,
  entityId: EntityId,
  requestId: RequestId,
  metadata: Record<string, unknown> = {}
): SimulationEvent {
  return createEvent(
    "REQUEST_QUEUED",
    timestamp,
    entityId,
    entityId,
    requestId,
    metadata
  );
}

/**
 * Creates a request-dequeued event — a previously queued request left the
 * backlog and began processing. Paired with createRequestQueuedEvent the
 * same way PROCESSING_STARTED/COMPLETED are paired, so queue length can be
 * derived by sweeping start/end markers (see MetricsCollector).
 */
export function createRequestDequeuedEvent(
  timestamp: Timestamp,
  entityId: EntityId,
  requestId: RequestId,
  metadata: Record<string, unknown> = {}
): SimulationEvent {
  return createEvent(
    "REQUEST_DEQUEUED",
    timestamp,
    entityId,
    entityId,
    requestId,
    metadata
  );
}

/**
 * Creates a request-failed event.
 */
export function createRequestFailedEvent(
  timestamp: Timestamp,
  source: EntityId | null,
  destination: EntityId | null,
  requestId: RequestId,
  reason: string,
  metadata: Record<string, unknown> = {}
): SimulationEvent {
  return createEvent(
    "REQUEST_FAILED",
    timestamp,
    source,
    destination,
    requestId,
    { reason, ...metadata }
  );
}

/**
 * Creates a queue-full event — an entity's backlog was already at
 * capacity when a new request arrived, so it was rejected outright.
 */
export function createQueueFullEvent(
  timestamp: Timestamp,
  entityId: EntityId,
  requestId: RequestId,
  metadata: Record<string, unknown> = {}
): SimulationEvent {
  return createEvent("QUEUE_FULL", timestamp, entityId, entityId, requestId, metadata);
}

/**
 * Creates a database-busy event — a database rejected a query because it
 * was already at its connection/queue limit.
 */
export function createDatabaseBusyEvent(
  timestamp: Timestamp,
  databaseId: EntityId,
  requestId: RequestId,
  metadata: Record<string, unknown> = {}
): SimulationEvent {
  return createEvent("DATABASE_BUSY", timestamp, databaseId, databaseId, requestId, metadata);
}

/**
 * Creates a rate-limit-admitted event — a rate limiter let a request
 * through. Paired with createRateLimitExceededEvent the same way
 * CACHE_HIT/CACHE_MISS are paired: emitted on every decision (not just
 * the reject side), so admitted/rejected counts don't depend on any
 * entity-type awareness elsewhere — MetricsCollector can trust that only
 * a RateLimiter ever emits either of these two event types.
 */
export function createRateLimitAdmittedEvent(
  timestamp: Timestamp,
  entityId: EntityId,
  requestId: RequestId,
  metadata: Record<string, unknown> = {}
): SimulationEvent {
  return createEvent(
    "RATE_LIMIT_ADMITTED",
    timestamp,
    entityId,
    entityId,
    requestId,
    metadata
  );
}

/**
 * Creates a rate-limit-exceeded event — a rate limiter rejected a request
 * because it had no tokens/window capacity left to admit it.
 */
export function createRateLimitExceededEvent(
  timestamp: Timestamp,
  entityId: EntityId,
  requestId: RequestId,
  metadata: Record<string, unknown> = {}
): SimulationEvent {
  return createEvent(
    "RATE_LIMIT_EXCEEDED",
    timestamp,
    entityId,
    entityId,
    requestId,
    metadata
  );
}

/**
 * Creates a circuit-breaker state-transition event — self-addressed,
 * same reasoning as QUEUE_FULL: a diagnostic marker, not something
 * anything downstream reacts to. `CIRCUIT_OPENED` fires both the first
 * time a breaker trips and any time a failed half-open probe reopens it —
 * "circuit is now open" means the same thing either way.
 */
export function createCircuitStateEvent(
  type: "CIRCUIT_OPENED" | "CIRCUIT_CLOSED" | "CIRCUIT_HALF_OPENED",
  timestamp: Timestamp,
  entityId: EntityId,
  requestId: RequestId,
  metadata: Record<string, unknown> = {}
): SimulationEvent {
  return createEvent(type, timestamp, entityId, entityId, requestId, metadata);
}

/**
 * Creates a cache hit or miss event.
 */
export function createCacheAccessEvent(
  type: "CACHE_HIT" | "CACHE_MISS",
  timestamp: Timestamp,
  cacheId: EntityId,
  requestId: RequestId,
  key: string,
  hit: boolean,
  metadata: Record<string, unknown> = {}
): SimulationEvent {
  return createEvent(
    type,
    timestamp,
    cacheId,
    null,
    requestId,
    { key, hit, ...metadata }
  );
}

/**
 * Creates a partition-assignment marker — which partition a Kafka message
 * hashed to, recorded at admission (a durable log write), independent of
 * whether any consumer group is even connected yet. Destination null,
 * same as CACHE_HIT/MISS: a diagnostic marker for the event log and
 * metrics, never delivered to any entity's handleEvent.
 */
export function createPartitionAssignedEvent(
  timestamp: Timestamp,
  entityId: EntityId,
  requestId: RequestId,
  partitionIndex: number,
  key: string
): SimulationEvent {
  return createEvent(
    "PARTITION_ASSIGNED",
    timestamp,
    entityId,
    null,
    requestId,
    { partitionIndex, key }
  );
}

/**
 * Creates a context-compaction marker — fires only on the turn a
 * MemoryContextStore's compaction policy actually triggers. Destination
 * null, same as CACHE_HIT/MISS/PARTITION_ASSIGNED: a diagnostic marker for
 * the event log and metrics, never delivered to any entity's handleEvent.
 */
export function createContextCompactionEvent(
  timestamp: Timestamp,
  entityId: EntityId,
  requestId: RequestId,
  policy: "none" | "summarization" | "scratchpad",
  contextSizeTokens: number,
  criticalInfoIntact: boolean
): SimulationEvent {
  return createEvent(
    "CONTEXT_COMPACTED",
    timestamp,
    entityId,
    null,
    requestId,
    { policy, contextSizeTokens, criticalInfoIntact }
  );
}

/**
 * Creates a guardrail-evaluated marker — fires on every
 * GuardrailValidator.evaluate() call, pass or fail. Destination null,
 * never delivered anywhere, same pattern as CONTEXT_COMPACTED/CACHE_HIT —
 * see docs/Agentic_AI.md §2.5's guardrailRejectionRate metric and this
 * EventType's own doc in events/types.ts for why a plain REQUEST_FAILED
 * sweep can't answer this.
 */
export function createGuardrailEvaluatedEvent(
  timestamp: Timestamp,
  entityId: EntityId,
  requestId: RequestId,
  passed: boolean,
  reason: string | null
): SimulationEvent {
  return createEvent(
    "GUARDRAIL_EVALUATED",
    timestamp,
    entityId,
    null,
    requestId,
    { passed, reason }
  );
}
