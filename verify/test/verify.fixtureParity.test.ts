import { describe, expect, it } from "vitest";
import { verify } from "../src/verify.js";

/**
 * The single most important test in this repo: proves the vendored,
 * ported engine produces the EXACT same numbers as the REAL, non-vendored
 * frontend engine for the same input — the strongest possible regression
 * guard that this is a faithful port, not a subtly-different
 * reimplementation.
 *
 * Fixture: url-shortener.ts's own scenario shape (seed 200, 8s @ 400 req/s
 * constant, keyPoolSize 30) with an "adequate, no cache" API/DB build
 * (API maxConcurrent=15/processingTimeMs=5, DB maxConnections=15/
 * processingTimeMs=10). Expected values below were captured by running
 * this EXACT fixture through the real, non-vendored engine directly in
 * the frontend repo (a throwaway comparison script, deleted after use —
 * see decisions.md) — not transcribed from the scenario file's prose
 * header comment, which describes a run whose exact queue-length/jitter
 * configuration doesn't fully match this simplified fixture closely
 * enough to reproduce its numbers exactly. Deriving "expected" from the
 * authoritative function's own real output, rather than from parsing a
 * comment, is the more rigorous methodology — it can't drift from a
 * misreading, only from an actual behavioral difference between the two
 * engines. Deliberately omits the scenario's real `optimalSolution` (not
 * needed to prove the core engine/scoring math matches).
 */
describe("verify — url-shortener fixture parity", () => {
  const scenario = {
    id: "url-shortener",
    title: "URL Shortener",
    seed: 200,
    durationMs: 8_000,
    trafficPattern: { type: "constant", rate: 400 },
    budgetUsd: 1400,
    requiresGatedToolCalls: false,
    constraints: [
      { id: "success-rate", metric: "successRate", comparator: "gte", threshold: 0.95, label: "success" },
      { id: "p95-latency", metric: "p95Latency", comparator: "lte", threshold: 100, label: "p95" },
    ],
  };

  const graph = {
    nodes: [
      { id: "client", type: "client", position: { x: 0, y: 0 }, config: { requestRate: 400, keyPoolSize: 30 } },
      { id: "api", type: "api", position: { x: 0, y: 0 }, config: { maxConcurrent: 15, processingTimeMs: 5 } },
      { id: "db", type: "database", position: { x: 0, y: 0 }, config: { maxConnections: 15, processingTimeMs: 10 } },
    ],
    connections: [
      { source: "client", target: "api" },
      { source: "api", target: "db" },
    ],
  };

  it("matches the real, non-vendored engine's output exactly", () => {
    const outcome = verify({ scenario, graph });
    const metrics = outcome.metrics as Record<string, number>;
    const score = outcome.score as Record<string, unknown>;

    expect(metrics.successRate).toBe(1);
    expect(metrics.p95Latency).toBe(26);
    expect(score.gatesPassed).toBe(true);
    // ~$762/mo — matches url-shortener.ts's own documented "Adequate, no
    // cache... $761/mo" tuning point closely (the small remainder is
    // unrelated to this bug fix, plausibly a queue-length/jitter default
    // this simplified fixture doesn't reproduce exactly — see this file's
    // header comment on methodology).
    expect(score.actualCostUsd).toBeCloseTo(762.1811400049914, 6);
    expect(score.composite).toBeCloseTo(0.7318616333321449, 10);
    expect(score.stars).toBe(2);
    expect(score.legendary).toBe(false);
  });
});
