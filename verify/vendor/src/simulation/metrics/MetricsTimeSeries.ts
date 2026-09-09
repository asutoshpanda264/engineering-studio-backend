/**
 * Buckets a finished event log into a fixed number of time windows, for
 * "how did this metric change over the run" charts.
 *
 * From: WORKSHOP-UI.md §13 — "Metrics should always be accompanied by
 * visual evidence. Users should never trust numbers without context."
 *
 * This is computed once from the immutable SimulationResult.events, the
 * same way collectMetrics is — not sampled during playback. Playback just
 * moves a cursor across an already-computed series (ARCHITECTURE.md's
 * "instant simulation, separate playback" applies here too: the history
 * already exists, the UI only points at where in it the reader is).
 *
 * Each bucket's numbers are scoped to that bucket's own window (e.g.
 * "success rate of requests that resolved between t=200 and t=400ms"),
 * not a running cumulative total — a cumulative view flattens out and
 * hides exactly the moments (a traffic spike, a queue filling up) this
 * chart exists to show.
 *
 * Zero React dependencies.
 */

import { average, percentile } from "./MetricsCollector";
import type { SimulationEvent } from "../events/types";
import type { EntityId, Timestamp } from "../types";

export interface MetricsTimeSeriesPoint {
  /** Start of this bucket's window, ms. */
  time: Timestamp;
  successRate: number;
  averageLatency: number;
  p95Latency: number;
  /** Requests completed per second, within this bucket only. */
  throughput: number;
}

const DEFAULT_BUCKET_COUNT = 40;

export function computeMetricsTimeSeries(
  events: SimulationEvent[],
  durationMs: number,
  bucketCount: number = DEFAULT_BUCKET_COUNT,
  /** Same filter as collectMetrics' clientIds — see its comment. */
  clientIds?: EntityId[]
): MetricsTimeSeriesPoint[] {
  if (durationMs <= 0 || bucketCount <= 0) return [];
  const bucketMs = durationMs / bucketCount;
  const clientIdSet = clientIds ? new Set(clientIds) : null;
  const countsTowardClientOutcome = (destination: EntityId | null): boolean =>
    !clientIdSet || (destination !== null && clientIdSet.has(destination));

  const buckets: { success: number; failed: number; latencies: number[] }[] =
    Array.from({ length: bucketCount }, () => ({
      success: 0,
      failed: 0,
      latencies: [],
    }));

  const bucketIndexFor = (t: Timestamp) =>
    Math.min(bucketCount - 1, Math.max(0, Math.floor(t / bucketMs)));

  for (const event of events) {
    if (event.type === "REQUEST_COMPLETED") {
      if (!countsTowardClientOutcome(event.destination)) continue;
      const bucket = buckets[bucketIndexFor(event.timestamp)];
      bucket.success++;
      if (typeof event.metadata.duration === "number") {
        bucket.latencies.push(event.metadata.duration);
      }
    } else if (event.type === "REQUEST_FAILED") {
      if (!countsTowardClientOutcome(event.destination)) continue;
      buckets[bucketIndexFor(event.timestamp)].failed++;
    }
  }

  return buckets.map((bucket, i) => {
    const sortedLatencies = [...bucket.latencies].sort((a, b) => a - b);
    const resolved = bucket.success + bucket.failed;
    return {
      time: Math.round(i * bucketMs),
      successRate: resolved > 0 ? bucket.success / resolved : 0,
      averageLatency: average(sortedLatencies),
      p95Latency: percentile(sortedLatencies, 0.95),
      throughput: bucket.success / (bucketMs / 1000),
    };
  });
}
