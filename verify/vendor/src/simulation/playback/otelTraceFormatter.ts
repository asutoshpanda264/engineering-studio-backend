/**
 * Formats a slice of `SimulationEvent[]` into the OpenTelemetry GenAI
 * tracing vocabulary `docs/Agentic_AI.md` §1.6/§2.4 describes — one
 * `invoke_agent` root span per request, nesting `chat`/`execute_tool`
 * (and every other agentic primitive's own) spans as children, all
 * sharing one synthetic `trace_id`. Per §2.4's own framing, this domain's
 * playback view needs no new simulation mechanism to get this — the
 * event log already has everything, this is purely a formatter.
 *
 * Zero React dependencies, same as everything else under `simulation/`.
 *
 * Nesting is reconstructed from time containment, not from parsing
 * `path`: every bounded-capacity entity here emits PROCESSING_STARTED at
 * the moment it begins working a request and PROCESSING_COMPLETED only
 * once it's genuinely done with it — for AgentOrchestrator specifically,
 * that means the WHOLE session (every dispatch, every retry, every
 * worker) per `AgentOrchestrator.ts`'s own `finalizeSession`. A parent
 * span's [start, end] therefore always encloses every child span's
 * [start, end] by construction, so a standard interval-stack algorithm
 * (sort by start, pop anything already closed, whatever's left on top of
 * the stack is the parent) reconstructs the real call tree without ever
 * needing to know *why* one entity called another.
 */

import type { EntityId, EntityType, RequestId, Timestamp } from "../types";
import type { SimulationEvent } from "../events/types";

export type OtelSpanName =
  | "invoke_agent"
  | "chat"
  | "execute_tool"
  | "retrieve"
  | "evaluate"
  | "context_compact"
  | "route"
  | "approve";

const SPAN_NAME_BY_ENTITY_TYPE: Partial<Record<EntityType, OtelSpanName>> = {
  agent_orchestrator: "invoke_agent",
  llm_call: "chat",
  tool_call: "execute_tool",
  retriever: "retrieve",
  guardrail_validator: "evaluate",
  memory_context_store: "context_compact",
  model_router: "route",
  human_in_loop_gate: "approve",
};

/** The three names OpenTelemetry's GenAI semantic conventions actually define — every other span name here is this project's own, informative but not a real `gen_ai.operation.name` value. */
const REAL_GEN_AI_OPERATION_NAMES: ReadonlySet<OtelSpanName> = new Set([
  "invoke_agent",
  "chat",
  "execute_tool",
]);

export interface OtelSpan {
  readonly spanId: string;
  readonly traceId: string;
  readonly name: OtelSpanName;
  readonly entityId: EntityId;
  readonly entityLabel: string;
  readonly startMs: Timestamp;
  readonly endMs: Timestamp;
  readonly attributes: Readonly<Record<string, string | number | boolean>>;
  readonly status: "ok" | "error";
  readonly errorReason?: string;
  readonly children: OtelSpan[];
}

export interface OtelTrace {
  readonly traceId: string;
  readonly requestId: RequestId;
  readonly rootSpan: OtelSpan;
  readonly outcome: "completed" | "failed" | "in_progress";
  readonly durationMs: number;
  /** True if any span on this trace's journey carries `compromised: true` — see RequestLifecycleMetadata's own doc. */
  readonly compromised: boolean;
  readonly compromiseReason?: string;
}

interface RawSpan {
  entityId: EntityId;
  entityType: EntityType | undefined;
  startMs: Timestamp;
  endMs: Timestamp;
}

/**
 * Builds one OtelTrace per requestId present in `events`, newest-started
 * first. `entityTypes` maps every node currently on the canvas to its
 * EntityType (and `entityLabels` to its display label) — the formatter
 * reads config-derived attributes (model tier, quantization) from
 * `entityConfigs`, keyed the same way, rather than the engine stamping
 * redundant copies of static config onto every single event.
 */
export function formatOtelTraces(
  events: readonly SimulationEvent[],
  entityTypes: Readonly<Record<EntityId, EntityType>>,
  entityLabels: Readonly<Record<EntityId, string>>,
  entityConfigs: Readonly<Record<EntityId, Record<string, unknown>>>
): OtelTrace[] {
  const byRequest = new Map<RequestId, SimulationEvent[]>();
  for (const event of events) {
    if (!event.requestId) continue;
    const list = byRequest.get(event.requestId);
    if (list) list.push(event);
    else byRequest.set(event.requestId, [event]);
  }

  const traces: OtelTrace[] = [];
  for (const [requestId, requestEvents] of byRequest) {
    const trace = buildTrace(requestId, requestEvents, entityTypes, entityLabels, entityConfigs);
    if (trace) traces.push(trace);
  }

  traces.sort((a, b) => b.rootSpan.startMs - a.rootSpan.startMs);
  return traces;
}

function buildTrace(
  requestId: RequestId,
  events: SimulationEvent[],
  entityTypes: Readonly<Record<EntityId, EntityType>>,
  entityLabels: Readonly<Record<EntityId, string>>,
  entityConfigs: Readonly<Record<EntityId, Record<string, unknown>>>
): OtelTrace | null {
  const rawSpans = pairProcessingSpans(events);
  if (rawSpans.length === 0) return null;

  const outcomeEvent = [...events]
    .reverse()
    .find((e) => e.type === "REQUEST_COMPLETED" || e.type === "REQUEST_FAILED");
  const outcome: OtelTrace["outcome"] = !outcomeEvent
    ? "in_progress"
    : outcomeEvent.type === "REQUEST_COMPLETED"
      ? "completed"
      : "failed";
  const errorReason =
    outcomeEvent?.type === "REQUEST_FAILED"
      ? (outcomeEvent.metadata.reason as string | undefined)
      : undefined;

  let compromised = false;
  let compromiseReason: string | undefined;
  for (const event of events) {
    const meta = event.metadata as { compromised?: boolean; compromiseReason?: string };
    if (meta.compromised) {
      compromised = true;
      compromiseReason = meta.compromiseReason ?? compromiseReason;
    }
  }

  const cacheEvent = events.find((e) => e.type === "CACHE_HIT" || e.type === "CACHE_MISS");
  const cacheAttributes: Record<string, string | number | boolean> = cacheEvent
    ? {
        "cache.hit": cacheEvent.type === "CACHE_HIT",
        "cache.key": String((cacheEvent.metadata as { key?: string }).key ?? ""),
      }
    : {};

  const startsByEntity = new Map<EntityId, Timestamp[]>();
  for (const raw of rawSpans) {
    const list = startsByEntity.get(raw.entityId) ?? [];
    list.push(raw.startMs);
    startsByEntity.set(raw.entityId, list);
  }
  for (const list of startsByEntity.values()) list.sort((a, b) => a - b);

  const spans = rawSpans.map((raw) => {
    const ownStarts = startsByEntity.get(raw.entityId) ?? [];
    const nextStartMs = ownStarts.find((s) => s > raw.startMs) ?? Infinity;
    return toOtelSpan(raw, nextStartMs, requestId, entityTypes, entityLabels, entityConfigs, cacheAttributes, events);
  });
  const root = nestSpans(spans);

  const minStart = Math.min(...rawSpans.map((s) => s.startMs));
  const maxEnd = Math.max(...rawSpans.map((s) => s.endMs));

  return {
    traceId: requestId,
    requestId,
    rootSpan:
      root.length === 1
        ? applyOutcome(root[0], outcome, errorReason)
        : applyOutcome(
            {
              spanId: `${requestId}_root`,
              traceId: requestId,
              name: "invoke_agent",
              entityId: "",
              entityLabel: "(implicit root — no agent_orchestrator on this request's path)",
              startMs: minStart,
              endMs: maxEnd,
              attributes: { "gen_ai.operation.name": "invoke_agent", ...cacheAttributes },
              status: "ok",
              children: root,
            },
            outcome,
            errorReason
          ),
    outcome,
    durationMs: maxEnd - minStart,
    compromised,
    compromiseReason,
  };
}

/** Applies the request's final outcome to whichever span is acting as this trace's root. */
function applyOutcome(
  span: OtelSpan,
  outcome: OtelTrace["outcome"],
  errorReason: string | undefined
): OtelSpan {
  if (outcome !== "failed") return span;
  return { ...span, status: "error", errorReason };
}

/**
 * Pairs every entity's own PROCESSING_STARTED/PROCESSING_COMPLETED events
 * for this request, in chronological arrival order per entity — an entity
 * visited more than once (an Agent Orchestrator retry, a Sequential step)
 * naturally produces one RawSpan per visit, non-overlapping, since a real
 * discrete-event start/complete pair for one visit always closes before
 * the next visit's own pair begins.
 */
function pairProcessingSpans(events: SimulationEvent[]): RawSpan[] {
  const startsByEntity = new Map<EntityId, Timestamp[]>();
  const spans: RawSpan[] = [];

  for (const event of events) {
    if (event.type !== "PROCESSING_STARTED" || !event.source) continue;
    const list = startsByEntity.get(event.source) ?? [];
    list.push(event.timestamp);
    startsByEntity.set(event.source, list);
  }

  for (const event of events) {
    if (event.type !== "PROCESSING_COMPLETED" || !event.source) continue;
    const starts = startsByEntity.get(event.source);
    const startMs = starts?.shift();
    if (startMs === undefined) continue;
    spans.push({ entityId: event.source, entityType: undefined, startMs, endMs: event.timestamp });
  }

  return spans;
}

function toOtelSpan(
  raw: RawSpan,
  nextStartMs: Timestamp,
  requestId: RequestId,
  entityTypes: Readonly<Record<EntityId, EntityType>>,
  entityLabels: Readonly<Record<EntityId, string>>,
  entityConfigs: Readonly<Record<EntityId, Record<string, unknown>>>,
  cacheAttributes: Record<string, string | number | boolean>,
  events: SimulationEvent[]
): OtelSpan {
  const entityType = entityTypes[raw.entityId];
  const name = (entityType && SPAN_NAME_BY_ENTITY_TYPE[entityType]) || "chat";
  const config = entityConfigs[raw.entityId] ?? {};

  const attributes: Record<string, string | number | boolean> = { ...cacheAttributes };
  if (REAL_GEN_AI_OPERATION_NAMES.has(name)) {
    attributes["gen_ai.operation.name"] = name;
    attributes["gen_ai.provider.name"] = "simulated";
  }

  if (entityType === "llm_call") {
    const tier = typeof config.tier === "string" ? config.tier : "llm";
    const quantization = typeof config.quantization === "string" ? config.quantization : "none";
    attributes["gen_ai.request.model"] = `${tier}-${quantization}`;
    attributes["llm.tier"] = tier;
    attributes["llm.quantization"] = quantization;
  }
  if (entityType === "tool_call") {
    attributes["gen_ai.tool.name"] = entityLabels[raw.entityId] ?? raw.entityId;
  }
  if (entityType === "agent_orchestrator") {
    attributes["agent.routing_mode"] =
      typeof config.routingMode === "string" ? config.routingMode : "sequential";
    attributes["agent.max_iterations"] =
      typeof config.maxIterations === "number" ? config.maxIterations : 3;
  }
  if (entityType === "guardrail_validator") {
    attributes["guardrail.mode"] = typeof config.mode === "string" ? config.mode : "gate";
  }
  if (entityType === "model_router") {
    attributes["model_router.mode"] =
      typeof config.mode === "string" ? config.mode : "confidence_cascade";
  }

  const ownFailure = findOriginatingFailure(events, raw, nextStartMs);

  return {
    spanId: `${requestId}_${raw.entityId}_${raw.startMs}`,
    traceId: requestId,
    name,
    entityId: raw.entityId,
    entityLabel: entityLabels[raw.entityId] ?? raw.entityId,
    startMs: raw.startMs,
    endMs: raw.endMs,
    attributes,
    status: ownFailure ? "error" : "ok",
    errorReason: ownFailure,
    children: [],
  };
}

/**
 * A span's own status should reflect whether THIS entity's own work failed
 * — not whether it's merely relaying an already-failed response back
 * toward the client, which every entity on the response leg does via a
 * plain `{...meta}` spread (see e.g. LlmCall.ts's `respond`). The
 * distinguishing signal is the transition: the event that triggered this
 * span (its arrival) did NOT already carry `failed: true`, but the event
 * this entity emitted at the moment its own processing completed DOES —
 * that's `fail()` being called here, not `respond()` passing a failure
 * through. Returns the failure reason if this span originated a failure,
 * undefined otherwise.
 */
function findOriginatingFailure(
  events: SimulationEvent[],
  raw: RawSpan,
  nextStartMs: Timestamp
): string | undefined {
  const arrival = [...events]
    .filter((e) => e.type === "REQUEST_ROUTED" && e.destination === raw.entityId && e.timestamp <= raw.startMs)
    .sort((a, b) => b.timestamp - a.timestamp)[0];
  const arrivalFailed = arrival ? (arrival.metadata as { failed?: boolean }).failed === true : false;
  if (arrivalFailed) return undefined;

  // This entity's own outward event for THIS visit — forward, respond, or
  // fail. Its timestamp is raw.endMs plus whatever connection latency
  // applies (fail()/respond() schedule at ctx.now + latencyTo(target)), so
  // it's found as the earliest outward event in the window between this
  // visit ending and this same entity's *next* visit beginning (if any) —
  // a real, necessary upper bound, since a later retry's own outward
  // event would otherwise be mistaken for this visit's.
  const outgoing = events
    .filter(
      (e) =>
        e.source === raw.entityId &&
        e.timestamp >= raw.endMs &&
        e.timestamp < nextStartMs &&
        (e.type === "REQUEST_FAILED" ||
          (e.type === "REQUEST_ROUTED" && (e.metadata as { failed?: boolean }).failed === true))
    )
    .sort((a, b) => a.timestamp - b.timestamp)[0];
  if (!outgoing) return undefined;
  return (
    (outgoing.metadata as { reason?: string; failureReason?: string }).reason ??
    (outgoing.metadata as { reason?: string; failureReason?: string }).failureReason
  );
}

/**
 * Stack-based interval nesting: sort spans by start time, and for each one
 * pop the stack past anything already closed by this span's start —
 * whatever's left on top is this span's parent (or none, meaning it's
 * top-level). Returns the top-level spans directly; buildTrace wraps them
 * in a synthetic root only when there's more than one.
 */
function nestSpans(spans: OtelSpan[]): OtelSpan[] {
  const sorted = [...spans].sort((a, b) => a.startMs - b.startMs);
  const roots: OtelSpan[] = [];
  const stack: OtelSpan[] = [];

  for (const span of sorted) {
    while (stack.length > 0 && stack[stack.length - 1].endMs <= span.startMs) {
      stack.pop();
    }
    if (stack.length === 0) {
      roots.push(span);
    } else {
      stack[stack.length - 1].children.push(span);
    }
    stack.push(span);
  }

  return roots;
}
