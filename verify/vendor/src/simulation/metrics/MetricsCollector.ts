/**
 * Derives a MetricsSnapshot from a finished event log.
 *
 * From: SIMULATION-ENGINE.md §10 — "Metrics Are Emergent"
 * Nothing here is incrementally tracked by entities during the run —
 * every number is recomputed from the immutable event array, so it stays
 * reproducible and independently testable.
 *
 * Zero React dependencies.
 */

import type { SimulationEvent } from "../events/types";
import type {
  CacheAvalancheMetrics,
  CachePenetrationMetrics,
  CacheStampedeMetrics,
  CDNEdgeMetrics,
  CircuitBreakerMetrics,
  CircuitBreakerState,
  EntityId,
  EntityMetrics,
  MemoryContextMetrics,
  MetricsSnapshot,
  RateLimiterMetrics,
  RoutingTargetMetrics,
} from "../types";

export function collectMetrics(
  events: SimulationEvent[],
  entityIds: EntityId[],
  totalDurationMs: number,
  /**
   * Ids of entities whose completions/failures represent an actual
   * client-originated request finishing (see Client.ts — "the lifecycle
   * simply ends at the client"). Optional and, when omitted, every
   * REQUEST_COMPLETED/REQUEST_FAILED is counted — the original behavior,
   * which callers that don't yet know their client ids (existing tests)
   * can keep relying on.
   *
   * Needed because MessageQueue acknowledges the client immediately, then
   * separately dispatches to its own downstream consumer under the same
   * requestId. That dispatch is a real, independently-simulated request —
   * it ends the same way any other does, with a REQUEST_COMPLETED/FAILED —
   * except addressed back to the queue, not a client. Without this filter
   * that second completion would double-count against totals that were
   * sized to one event per client-issued request.
   */
  clientIds?: EntityId[],
  /**
   * Ids of Agent Orchestrator entities in this run, if any — see
   * `MetricsSnapshot.totalIterations`'s own doc. Optional so every
   * existing call site (tests, callers that don't yet know entity types)
   * keeps working unchanged; omitting it just means `totalIterations`
   * stays `undefined`, the same "not applicable" convention every other
   * optional metric here follows.
   */
  agentOrchestratorIds?: EntityId[],
  /** Ids of Guardrail Validator entities in this run, if any — see `MetricsSnapshot.guardrailRejectionRate`'s own doc. Same optionality reasoning as agentOrchestratorIds. */
  guardrailValidatorIds?: EntityId[]
): MetricsSnapshot {
  const clientIdSet = clientIds ? new Set(clientIds) : null;
  const countsTowardClientOutcome = (destination: EntityId | null): boolean =>
    !clientIdSet || (destination !== null && clientIdSet.has(destination));

  let totalRequests = 0;
  let successfulRequests = 0;
  let failedRequests = 0;
  const latencies: number[] = [];

  const entityMetrics: Record<EntityId, EntityMetrics> = {};
  for (const id of entityIds) {
    entityMetrics[id] = {
      utilization: 0,
      requestCount: 0,
      errorCount: 0,
      queueLength: 0,
    };
  }

  const activityByEntity = new Map<EntityId, { time: number; delta: 1 | -1 }[]>();
  const queueActivityByEntity = new Map<EntityId, { time: number; delta: 1 | -1 }[]>();
  const cacheAccessByEntity = new Map<
    EntityId,
    {
      hits: number;
      misses: number;
      coalescedMisses: number;
      /** Misses answered straight from a negative-cache entry — see Cache.ts's negativeCaching. */
      negativeHits: number;
      /** Misses for a key confirmed nonexistent that still reached downstream (naive mode, or no negative-cache entry existed yet). */
      downstreamNotFoundMisses: number;
      /** Timestamps of misses caused by a previously-cached entry's TTL expiring — feeds cacheAvalanche's peak-burst calc. */
      expiredMissTimestamps: number[];
    }
  >();
  const edgeAccessByEntity = new Map<EntityId, Map<number, { hits: number; misses: number }>>();
  const routingByEntity = new Map<EntityId, Map<EntityId, number>>();
  const partitionByEntity = new Map<EntityId, Map<number, number>>();
  const rateLimiterByEntity = new Map<EntityId, { admitted: number; rejected: number }>();
  const guardrailEvalByEntity = new Map<EntityId, { checks: number; rejections: number }>();
  const memoryContextByEntity = new Map<
    EntityId,
    { policy: MemoryContextMetrics["policy"]; compactionCount: number; criticalInfoIntact: boolean; currentContextTokens: number }
  >();
  const circuitBreakerByEntity = new Map<
    EntityId,
    { state: CircuitBreakerState; tripCount: number }
  >();

  for (const event of events) {
    switch (event.type) {
      case "REQUEST_STARTED":
        totalRequests++;
        break;
      case "REQUEST_COMPLETED":
        if (countsTowardClientOutcome(event.destination)) {
          successfulRequests++;
          if (typeof event.metadata.duration === "number") {
            latencies.push(event.metadata.duration);
          }
        }
        break;
      case "REQUEST_FAILED":
      case "QUEUE_FULL":
      case "DATABASE_BUSY":
      case "CONNECTION_REJECTED":
        if (event.type === "REQUEST_FAILED" && countsTowardClientOutcome(event.destination)) {
          failedRequests++;
        }
        if (event.source && entityMetrics[event.source]) {
          entityMetrics[event.source].errorCount++;
        }
        break;
      case "PROCESSING_STARTED":
        if (event.source && entityMetrics[event.source]) {
          entityMetrics[event.source].requestCount++;
        }
        recordActivity(activityByEntity, event.source, event.timestamp, 1);
        break;
      case "PROCESSING_COMPLETED":
        recordActivity(activityByEntity, event.source, event.timestamp, -1);
        break;
      case "REQUEST_ROUTED":
        if (event.source && event.destination && event.metadata.direction === "request") {
          const targets = routingByEntity.get(event.source) ?? new Map<EntityId, number>();
          targets.set(event.destination, (targets.get(event.destination) ?? 0) + 1);
          routingByEntity.set(event.source, targets);
        }
        break;
      case "RATE_LIMIT_ADMITTED":
      case "RATE_LIMIT_EXCEEDED": {
        // Doesn't also bump errorCount here: a rejection's companion
        // REQUEST_FAILED (same source) already does that via the
        // REQUEST_FAILED case above — bumping it here too would
        // double-count every rejection.
        if (!event.source) break;
        const counts = rateLimiterByEntity.get(event.source) ?? { admitted: 0, rejected: 0 };
        if (event.type === "RATE_LIMIT_ADMITTED") counts.admitted++;
        else counts.rejected++;
        rateLimiterByEntity.set(event.source, counts);
        break;
      }
      case "CIRCUIT_OPENED":
      case "CIRCUIT_CLOSED":
      case "CIRCUIT_HALF_OPENED": {
        if (!event.source) break;
        // "Last one wins" rather than a sweep — state is point-in-time,
        // not an interval, and `events` is already chronologically
        // ordered (the discrete-event queue dequeues in timestamp order).
        // Given the caller may have already scoped `events` to "everything
        // up to now" (playback scrubbing), this naturally reflects the
        // breaker's real state as of that instant.
        const current = circuitBreakerByEntity.get(event.source) ?? {
          state: "closed" as CircuitBreakerState,
          tripCount: 0,
        };
        current.state =
          event.type === "CIRCUIT_OPENED"
            ? "open"
            : event.type === "CIRCUIT_CLOSED"
              ? "closed"
              : "half_open";
        if (event.type === "CIRCUIT_OPENED") current.tripCount++;
        circuitBreakerByEntity.set(event.source, current);
        break;
      }
      case "REQUEST_QUEUED":
        recordActivity(queueActivityByEntity, event.source, event.timestamp, 1);
        break;
      case "REQUEST_DEQUEUED":
        recordActivity(queueActivityByEntity, event.source, event.timestamp, -1);
        break;
      case "CACHE_HIT":
      case "CACHE_MISS": {
        if (!event.source) break;
        const counts =
          cacheAccessByEntity.get(event.source) ?? {
            hits: 0,
            misses: 0,
            coalescedMisses: 0,
            negativeHits: 0,
            downstreamNotFoundMisses: 0,
            expiredMissTimestamps: [],
          };
        if (event.type === "CACHE_HIT") counts.hits++;
        else {
          counts.misses++;
          const coalesced = event.metadata.coalesced === true;
          const negative = event.metadata.negative === true;
          const notFound = event.metadata.notFound === true;
          if (coalesced) counts.coalescedMisses++;
          if (negative) counts.negativeHits++;
          // "Downstream" here specifically means "this miss, on its own,
          // triggered a real downstream round trip for a phantom key" — a
          // coalesced follower shared someone else's trip, and a negative
          // hit avoided one entirely, so both are excluded.
          if (notFound && !coalesced && !negative) counts.downstreamNotFoundMisses++;
          if (event.metadata.expired === true) counts.expiredMissTimestamps.push(event.timestamp);
        }
        cacheAccessByEntity.set(event.source, counts);

        if (typeof event.metadata.edgeIndex === "number") {
          const edgeMap = edgeAccessByEntity.get(event.source) ?? new Map();
          const edgeCounts = edgeMap.get(event.metadata.edgeIndex) ?? { hits: 0, misses: 0 };
          if (event.type === "CACHE_HIT") edgeCounts.hits++;
          else edgeCounts.misses++;
          edgeMap.set(event.metadata.edgeIndex, edgeCounts);
          edgeAccessByEntity.set(event.source, edgeMap);
        }
        break;
      }
      case "CONTEXT_COMPACTED": {
        if (!event.source) break;
        const policy = event.metadata.policy as MemoryContextMetrics["policy"] | undefined;
        if (!policy) break;
        const current = memoryContextByEntity.get(event.source) ?? {
          policy,
          compactionCount: 0,
          criticalInfoIntact: true,
          currentContextTokens: 0,
        };
        current.policy = policy;
        current.compactionCount++;
        // "Last one wins" — same point-in-time reasoning CIRCUIT_OPENED
        // above uses — reflects the most recent compaction, not the first.
        if (typeof event.metadata.criticalInfoIntact === "boolean") {
          current.criticalInfoIntact = event.metadata.criticalInfoIntact;
        }
        if (typeof event.metadata.contextSizeTokens === "number") {
          current.currentContextTokens = event.metadata.contextSizeTokens;
        }
        memoryContextByEntity.set(event.source, current);
        break;
      }
      case "GUARDRAIL_EVALUATED": {
        if (!event.source) break;
        const counts = guardrailEvalByEntity.get(event.source) ?? { checks: 0, rejections: 0 };
        counts.checks++;
        if (event.metadata.passed === false) counts.rejections++;
        guardrailEvalByEntity.set(event.source, counts);
        break;
      }
      case "PARTITION_ASSIGNED": {
        if (!event.source) break;
        if (typeof event.metadata.partitionIndex !== "number") break;
        const partitionMap = partitionByEntity.get(event.source) ?? new Map<number, number>();
        partitionMap.set(
          event.metadata.partitionIndex,
          (partitionMap.get(event.metadata.partitionIndex) ?? 0) + 1
        );
        partitionByEntity.set(event.source, partitionMap);
        break;
      }
      default:
        break;
    }
  }

  for (const [entityId, intervals] of activityByEntity) {
    const metrics = entityMetrics[entityId];
    if (!metrics) continue;
    metrics.utilization = computeUtilization(intervals, totalDurationMs);
  }

  for (const [entityId, counts] of cacheAccessByEntity) {
    const metrics = entityMetrics[entityId];
    if (!metrics) continue;
    const attempts = counts.hits + counts.misses;
    metrics.cacheHitRate = attempts > 0 ? counts.hits / attempts : 0;
    if (counts.misses > 0) {
      // "Independent" means "triggered its own downstream fetch" — a
      // negative hit didn't, same reasoning a coalesced miss already
      // didn't, so both are subtracted out here too.
      const cacheStampede: CacheStampedeMetrics = {
        coalescedMisses: counts.coalescedMisses,
        independentMisses: counts.misses - counts.coalescedMisses - counts.negativeHits,
      };
      metrics.cacheStampede = cacheStampede;
    }
    if (counts.negativeHits > 0 || counts.downstreamNotFoundMisses > 0) {
      const cachePenetration: CachePenetrationMetrics = {
        negativeHits: counts.negativeHits,
        downstreamMisses: counts.downstreamNotFoundMisses,
      };
      metrics.cachePenetration = cachePenetration;
    }
    if (counts.expiredMissTimestamps.length > 0) {
      const cacheAvalanche: CacheAvalancheMetrics = {
        expiredMisses: counts.expiredMissTimestamps.length,
        peakExpiryBurst: computePeakBurst(counts.expiredMissTimestamps, AVALANCHE_WINDOW_MS),
      };
      metrics.cacheAvalanche = cacheAvalanche;
    }
  }

  for (const [entityId, edgeMap] of edgeAccessByEntity) {
    const metrics = entityMetrics[entityId];
    if (!metrics) continue;
    const cdnEdges: CDNEdgeMetrics[] = [...edgeMap.entries()]
      .sort(([a], [b]) => a - b)
      .map(([edgeIndex, counts]) => {
        const requests = counts.hits + counts.misses;
        return {
          edgeIndex,
          requests,
          misses: counts.misses,
          hitRate: requests > 0 ? counts.hits / requests : 0,
        };
      });
    metrics.cdnEdges = cdnEdges;
  }

  for (const [entityId, targets] of routingByEntity) {
    const metrics = entityMetrics[entityId];
    if (!metrics) continue;
    const routingDistribution: RoutingTargetMetrics[] = [...targets.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([targetId, requests]) => ({ targetId, requests }));
    metrics.routingDistribution = routingDistribution;

    // Zero-capacity routers (LoadBalancer, ReverseProxy — see their own
    // class docs: "has no capacity of its own") never emit
    // PROCESSING_STARTED, so requestCount above stays 0 for them no matter
    // how much traffic they successfully route. Left alone, that makes
    // attempts = requestCount + errorCount collapse to just errorCount —
    // any single failure forwarded back through the router (which *does*
    // count against it, since the response-forwarding hop's source is the
    // router) reads as a 100% failure rate, misattributing a downstream
    // target's crash to the router itself (see nodeStatus.ts's
    // CRASH_FAILURE_RATE and RemediesPanel.tsx's worstEntityHealth, both
    // of which read requestCount/errorCount this same way). A router that
    // never processes still legitimately *routes* — use the requests it
    // actually dispatched (already summed here) as its request count, but
    // only as a fallback: a processing entity (APIServer forwarding
    // downstream after finishing its own work, say) already has an
    // accurate PROCESSING_STARTED-derived count and must not have this
    // routed-count layered on top of it, which is exactly what the
    // `=== 0` guard prevents.
    if (metrics.requestCount === 0) {
      metrics.requestCount = routingDistribution.reduce((sum, t) => sum + t.requests, 0);
    }
  }

  for (const [entityId, partitions] of partitionByEntity) {
    const metrics = entityMetrics[entityId];
    if (!metrics) continue;
    const kafkaPartitions: RoutingTargetMetrics[] = [...partitions.entries()]
      .sort(([a], [b]) => a - b)
      .map(([partitionIndex, messages]) => ({
        targetId: `Partition ${partitionIndex}`,
        requests: messages,
      }));
    metrics.kafkaPartitions = kafkaPartitions;
  }

  for (const [entityId, counts] of rateLimiterByEntity) {
    const metrics = entityMetrics[entityId];
    if (!metrics) continue;
    const rateLimiter: RateLimiterMetrics = { ...counts };
    metrics.rateLimiter = rateLimiter;
  }

  for (const [entityId, counts] of circuitBreakerByEntity) {
    const metrics = entityMetrics[entityId];
    if (!metrics) continue;
    const circuitBreaker: CircuitBreakerMetrics = { ...counts };
    metrics.circuitBreaker = circuitBreaker;
  }

  for (const [entityId, counts] of memoryContextByEntity) {
    const metrics = entityMetrics[entityId];
    if (!metrics) continue;
    const memoryContext: MemoryContextMetrics = { ...counts };
    metrics.memoryContext = memoryContext;
  }

  for (const [entityId, intervals] of queueActivityByEntity) {
    const metrics = entityMetrics[entityId];
    if (!metrics) continue;
    metrics.queueLength = computeCurrentCount(intervals);
  }

  latencies.sort((a, b) => a - b);

  // docs/Agentic_AI.md §2.5 — see MetricsSnapshot.totalIterations's own
  // doc. dispatchCount reuses routingByEntity (already swept above for
  // routingDistribution) rather than a second pass over `events`.
  let totalIterations: number | undefined;
  if (agentOrchestratorIds && agentOrchestratorIds.length > 0) {
    totalIterations = 0;
    for (const id of agentOrchestratorIds) {
      const targets = routingByEntity.get(id);
      const dispatchCount = targets
        ? [...targets.values()].reduce((sum, count) => sum + count, 0)
        : 0;
      const sessionCount = entityMetrics[id]?.requestCount ?? 0;
      totalIterations += Math.max(0, dispatchCount - sessionCount);
    }
  }

  // docs/Agentic_AI.md §2.5 — see MetricsSnapshot.guardrailRejectionRate's
  // own doc. Reads GUARDRAIL_EVALUATED markers, not REQUEST_FAILED/
  // errorCount: a Guardrail Validator's own normal placement (inside an
  // Agent Orchestrator's retry loop, not client-adjacent) means it never
  // itself emits REQUEST_FAILED, so errorCount undercounts — see
  // GuardrailValidator.ts's own doc on this marker.
  let guardrailRejectionRate: number | undefined;
  if (guardrailValidatorIds && guardrailValidatorIds.length > 0) {
    let checks = 0;
    let rejections = 0;
    for (const id of guardrailValidatorIds) {
      const counts = guardrailEvalByEntity.get(id);
      if (!counts) continue;
      checks += counts.checks;
      rejections += counts.rejections;
    }
    guardrailRejectionRate = checks > 0 ? rejections / checks : 0;
  }

  return {
    totalRequests,
    successfulRequests,
    failedRequests,
    successRate: totalRequests > 0 ? successfulRequests / totalRequests : 0,
    averageLatency: average(latencies),
    p50Latency: percentile(latencies, 0.5),
    p95Latency: percentile(latencies, 0.95),
    p99Latency: percentile(latencies, 0.99),
    throughput:
      totalDurationMs > 0 ? successfulRequests / (totalDurationMs / 1000) : 0,
    entityMetrics,
    totalIterations,
    guardrailRejectionRate,
  };
}

function recordActivity(
  map: Map<EntityId, { time: number; delta: 1 | -1 }[]>,
  entityId: EntityId | null,
  time: number,
  delta: 1 | -1
): void {
  if (!entityId) return;
  const list = map.get(entityId) ?? [];
  list.push({ time, delta });
  map.set(entityId, list);
}

/**
 * Sweep-line over start/end markers so overlapping (concurrent) work
 * doesn't double-count busy time — utilization is the fraction of
 * wall-clock time the entity had at least one active request.
 */
function computeUtilization(
  intervals: { time: number; delta: 1 | -1 }[],
  totalDurationMs: number
): number {
  if (totalDurationMs <= 0) return 0;
  const sorted = [...intervals].sort((a, b) => a.time - b.time);

  let concurrency = 0;
  let busyTime = 0;
  let lastTime = sorted.length > 0 ? sorted[0].time : 0;

  for (const point of sorted) {
    if (concurrency > 0) busyTime += point.time - lastTime;
    concurrency += point.delta;
    lastTime = point.time;
  }

  return Math.min(1, busyTime / totalDurationMs);
}

/**
 * Net running sum of start/end markers — unlike computeUtilization this
 * isn't a fraction of a window, it's a point-in-time count (how many
 * requests are sitting in the backlog once every marker in `events` has
 * been applied). Given the caller already scoped `events` to "everything
 * up to now" (see PlaybackController), this is exactly the queue length
 * as of that instant. By the end of a fully-drained simulation it's
 * always 0 — nothing queued is ever left un-dequeued if the discrete-event
 * loop ran to completion.
 */
function computeCurrentCount(intervals: { time: number; delta: 1 | -1 }[]): number {
  const sorted = [...intervals].sort((a, b) => a.time - b.time);
  let count = 0;
  for (const point of sorted) count += point.delta;
  return Math.max(0, count);
}

/** Window (ms) used to size a cache avalanche's "wave" — how many
 * TTL-expiry misses land within this close together, at their most
 * bunched, anywhere in the run. */
const AVALANCHE_WINDOW_MS = 100;

/**
 * The largest number of timestamps that fall within any `windowMs` sliding
 * window of each other — the quantified size of an avalanche's "wave" of
 * synchronized re-fetches. A classic two-pointer sweep over sorted
 * timestamps, O(n log n) for the sort plus O(n) for the sweep.
 */
function computePeakBurst(timestamps: number[], windowMs: number): number {
  const sorted = [...timestamps].sort((a, b) => a - b);
  let left = 0;
  let peak = 0;
  for (let right = 0; right < sorted.length; right++) {
    while (sorted[right] - sorted[left] > windowMs) left++;
    peak = Math.max(peak, right - left + 1);
  }
  return peak;
}

/** Exported for reuse by MetricsTimeSeries.ts — same definition, one source of truth. */
export function average(sortedValues: number[]): number {
  if (sortedValues.length === 0) return 0;
  return sortedValues.reduce((sum, v) => sum + v, 0) / sortedValues.length;
}

export function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(
    sortedValues.length - 1,
    Math.ceil(p * sortedValues.length) - 1
  );
  return sortedValues[Math.max(0, index)];
}
