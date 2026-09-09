/**
 * Simulation event types.
 *
 * Events are the smallest observable unit in the simulation.
 * Every event is immutable and append-only — the event log is the
 * single source of truth for all visualization, metrics, and playback.
 *
 * From: TECHNICAL-SPECIFICATION.md §5 — Event
 *
 * Every event must contain:
 *   - Unique ID
 *   - Timestamp
 *   - Type
 *   - Source
 *   - Destination
 *   - Request ID
 *   - Metadata
 */

import type { EntityId, RequestId, Timestamp } from "../types";

export type { EntityId, RequestId, Timestamp };

/**
 * All possible event types, grouped by category.
 * From: TECHNICAL-SPECIFICATION.md §6 — Event Categories
 */
export type EventType =
  // Infrastructure events
  | "REQUEST_STARTED"
  | "REQUEST_ROUTED"
  | "REQUEST_COMPLETED"
  | "REQUEST_FAILED"
  | "TIMEOUT"
  | "RETRY"
  // Entity events
  | "QUEUE_FULL"
  | "CACHE_HIT"
  | "CACHE_MISS"
  | "DATABASE_BUSY"
  | "CONNECTION_REJECTED"
  | "RATE_LIMIT_ADMITTED"
  | "RATE_LIMIT_EXCEEDED"
  | "CIRCUIT_OPENED"
  | "CIRCUIT_CLOSED"
  | "CIRCUIT_HALF_OPENED"
  // Self-addressed diagnostic marker, same pattern as CACHE_HIT/MISS —
  // fires only on turns that trigger MemoryContextStore's compaction
  // policy, carrying the resulting context size and whether critical
  // info survived. See MemoryContextStore.ts.
  | "CONTEXT_COMPACTED"
  // Diagnostic marker, never delivered anywhere (destination null, same
  // as CACHE_HIT/MISS) — records which partition a Kafka message was
  // assigned to, independent of whether any consumer group exists yet.
  | "PARTITION_ASSIGNED"
  // Self-addressed diagnostic marker, same pattern as CONTEXT_COMPACTED —
  // fires on every GuardrailValidator.evaluate() call, pass or fail.
  // docs/Agentic_AI.md §2.5's guardrailRejectionRate metric needs this:
  // a guardrail deep in a real composition (inside an Agent Orchestrator's
  // retry loop, GuardrailValidator's own documented normal placement)
  // never itself emits REQUEST_FAILED — only whichever entity sits
  // client-adjacent along the response path does, attributed to *that*
  // entity, not the guardrail that actually made the call. This marker
  // is the guardrail reporting its own outcome directly, the same
  // reasoning CONTEXT_COMPACTED's own doc gives for MemoryContextStore.
  | "GUARDRAIL_EVALUATED"
  // Processing lifecycle — any entity that does bounded-capacity work
  // (APIServer, Database, ...) emits these around that work, so utilization
  // metrics can be derived by pairing start/complete per entity.
  | "PROCESSING_STARTED"
  | "PROCESSING_COMPLETED"
  // Backlog lifecycle — brackets time a request spends waiting once
  // capacity is full, as opposed to PROCESSING_STARTED/COMPLETED which
  // bracket active work. Pairing these the same way derives queue length.
  | "REQUEST_QUEUED"
  | "REQUEST_DEQUEUED"
  // System events
  | "SIMULATION_STARTED"
  | "SIMULATION_FINISHED"
  | "SCENARIO_EVENT"
  | "FAILURE_INJECTED"
  | "TRAFFIC_SPIKE"
  | "RECOVERY"
  // Playback events (metadata for the UI)
  | "PLAYBACK_STARTED"
  | "PLAYBACK_PAUSED"
  | "PLAYBACK_RESUMED"
  | "PLAYBACK_SEEKED";

/**
 * The immutable simulation event — the atomic unit of truth.
 */
export interface SimulationEvent {
  readonly id: string;
  readonly timestamp: Timestamp;
  readonly type: EventType;
  readonly source: EntityId | null; // null for system-wide events
  readonly destination: EntityId | null; // null for client-originated requests
  readonly requestId: RequestId | null; // null for system/scenario events
  readonly metadata: Record<string, unknown>;
}

/**
 * Metadata shape for REQUEST_STARTED events.
 */
export interface RequestStartedMetadata {
  requestId: RequestId;
  path?: string;
  priority?: number;
}

/**
 * Metadata shape for REQUEST_COMPLETED events.
 */
export interface RequestCompletedMetadata {
  requestId: RequestId;
  duration: number; // total time from start to completion (ms)
  statusCode?: number;
}

/**
 * Metadata shape for REQUEST_FAILED events.
 */
export interface RequestFailedMetadata {
  requestId: RequestId;
  reason: string;
  statusCode?: number;
}

/**
 * Metadata shape for CACHE_HIT / CACHE_MISS events.
 */
export interface CacheAccessMetadata {
  requestId: RequestId;
  key: string;
  hit: boolean;
  cachedAt?: number; // when the key was cached (ms)
}

/**
 * Metadata shape for CONTEXT_COMPACTED events — see MemoryContextStore.ts.
 */
export interface ContextCompactionMetadata {
  requestId: RequestId;
  policy: "none" | "summarization" | "scratchpad";
  /** Context size, in tokens, immediately after this compaction. */
  contextSizeTokens: number;
  /** Whether the assumed-early "critical info" is still intact after this compaction. */
  criticalInfoIntact: boolean;
}

/**
 * Metadata shape for GUARDRAIL_EVALUATED events — see GuardrailValidator.ts.
 */
export interface GuardrailEvaluatedMetadata {
  requestId: RequestId;
  passed: boolean;
  /** Only meaningful when passed is false — mirrors the reason the standard REQUEST_FAILED/failureReason would carry. */
  reason: string | null;
}

/**
 * Carried on every event as a request moves through the architecture.
 * Each hop copies this forward so any entity can compute end-to-end
 * duration or respond to whoever sent it, without a shared registry —
 * every entity only knows what's in the event it received (Local Knowledge).
 */
export interface RequestLifecycleMetadata extends Record<string, unknown> {
  /** Timestamp the request originated at the Client — used to compute duration. */
  startedAt: Timestamp;
  /** Whether this hop is on the way to the database ("request") or back ("response"). */
  direction: "request" | "response";
  /** Entity ids visited so far, in order, starting with the Client. */
  path: EntityId[];
  /**
   * Which resource this request is for — drawn from a skewed distribution
   * over the Client's Key Pool Size, so some keys repeat far more than
   * others (see TrafficGenerator.assignRequestKey). This is what makes a
   * Cache's hit rate meaningful: identical keys can hit, unique ones can't.
   */
  key: string;
  /**
   * Which named service this request is meant for — drawn uniformly from
   * the Client's Route Pool Size over TrafficGenerator's fixed ROUTE_LABELS
   * (see assignRequestRoute), unlike `key` which is skewed. Only Reverse
   * Proxy reads this; every other entity ignores it. A request never
   * generated with a Reverse Proxy anywhere downstream simply never has
   * this value consulted — always present so a Reverse Proxy dropped in
   * later still has something to route on, without needing to regenerate
   * traffic.
   */
  route?: string;
  /**
   * Set on a response-direction hop that's carrying a failure back toward
   * the client, rather than a successful result. Every entity that passes
   * a response through unchanged (object-spreading `...meta`) propagates
   * this for free; only the entity that terminates the response leg at
   * the client needs to branch on it (REQUEST_FAILED vs REQUEST_COMPLETED),
   * and only entities that store or act on returned data (Cache, CDN) need
   * to check it before treating a returning response as real data.
   */
  failed?: boolean;
  /** The failure reason to surface at the client — only meaningful when `failed` is true. */
  failureReason?: string;
  /**
   * Whether the resource this request is for actually exists, decided once
   * at the Client from the Client's Missing Key Rate config (see
   * TrafficGenerator.assignRequestExistence) and carried forward like
   * `key`. Absent or `true` means the normal case — every existing
   * request/test that never sets this behaves exactly as before. Only
   * `false` is meaningful: it marks a request for a key that will never be
   * found no matter how far downstream it travels (a typo'd id, a deleted
   * record, an attacker probing for valid ids) — cache penetration. Only
   * Cache reads this (see Cache.ts's Negative Caching); every other entity
   * ignores it and would otherwise "succeed" a phantom-key request, since
   * none of them model per-key existence themselves.
   */
  exists?: boolean;
  /**
   * Whether this request needs multi-hop relationship reasoning to answer
   * correctly, decided once at the Client from the Client's Relationship
   * Query Rate config (see TrafficGenerator.assignRequestRelationshipQuery)
   * and carried forward like `key`/`exists`. Absent or `false` means the
   * normal case — a single similarity-matched chunk can answer it. Only
   * Retriever reads this (see Retriever.ts's GraphRAG mode); every other
   * entity ignores it.
   */
  requiresRelationshipTraversal?: boolean;
  /**
   * Set when this request's content has been quietly compromised somewhere
   * on its journey, WITHOUT itself becoming a REQUEST_FAILED — a tool
   * response that comes back 200-but-empty (failure mode #4, silent tool
   * failure), a hijacked llm_call output (#9, direct prompt injection), or
   * poisoned retrieved content (#10, indirect prompt injection). This is
   * `docs/Agentic_AI.md` §1.7's "agent failures often look like success in
   * a trace" made literal: every entity that passes a response through
   * unchanged (`...meta`) propagates this for free, the same as `failed`.
   * Only GuardrailValidator's `compromiseCatchRate` reads it (rolling a
   * chance to catch and fail the request instead) — every other entity
   * ignores it and happily treats a compromised-but-"successful" response
   * as fine, which is the whole point of the demo: without a guardrail
   * wired downstream, this reaches the client with `failed` never set.
   */
  compromised?: boolean;
  /** Which specific compromise this is — only meaningful when `compromised` is true. */
  compromiseReason?: "silent_tool_failure" | "direct_prompt_injection" | "indirect_prompt_injection";
}
