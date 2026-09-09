/**
 * Turns a completed run into a scenario's pass/fail + star rating.
 *
 * Deliberately outside `src/scenarios/` (which stays framework-independent,
 * see its own types.ts header) because scoring needs `estimateCost`, which
 * reads the live canvas' `ArchitectureNode[]` — a scenario's own
 * `constraints` only ever needed a `MetricsSnapshot` (see validator.ts),
 * but cost isn't part of that snapshot at all, it's a separate projection
 * over config the Workshop computes. Same layering `costEngine.ts` and
 * `nodeStatus.ts` already use: `scenarios/` declares data, `lib/`
 * interprets it against runtime state.
 *
 * Gates first, quality second: a scenario's existing constraints
 * (success rate, p95 latency, ...) plus its budget are hard pass/fail —
 * over budget means the scenario isn't solved, full stop, the same as
 * failing the latency constraint. Stars only ever grade a solution that
 * already passed every gate; they're the answer to "now that it works, how
 * well did you build it," never a substitute for actually working.
 */

import type { EntityId, EntityType, SimulationConfig, SimulationResult } from "@/simulation/types";
import type { Scenario } from "@/scenarios/types";
import { evaluateScenario } from "@/scenarios/validator";
import type { ScenarioEvaluation } from "@/scenarios/validator";
import { runSimulation } from "@/simulation/engine/Simulator";
import { estimateCost } from "@/lib/costEngine";
import { hasUnguardedBackendAccess, hasUnguardedIrreversibleAction } from "@/lib/architectureValidation";
import type { ArchitectureNode } from "@/store/workshopStore";

export interface ScenarioScore {
  evaluation: ScenarioEvaluation;
  actualCostUsd: number;
  budgetUsd: number | null;
  budgetPassed: boolean;
  /** True unless some Client's traffic can reach a storage/broker entity (Database, Cache, ...) without passing through an API Server first — see architectureValidation.ts. */
  architectureValid: boolean;
  /** evaluation.passed && budgetPassed && architectureValid — stars are 0 unless this is true. */
  gatesPassed: boolean;
  /** 0..1, only meaningful when gatesPassed (0 otherwise, by construction). */
  composite: number;
  /** 4 is deliberately skipped — 5 only ever means "beat the reference," never "close to it." */
  stars: 0 | 1 | 2 | 3 | 5;
  /** True exactly when stars === 5 — a student's own build outscored `scenario.optimalSolution`. */
  legendary: boolean;
  /** The reference solution's own composite, for UI progress display. Null if the scenario has no `optimalSolution`, or it fails its own gates (a tuning bug, not a real state). */
  optimalComposite: number | null;
}

// Composite score → star tier. A composite of 0 sits right at the pass bar
// on every axis at once (the worst a gates-passing solution can score) —
// 1 star already means "it works," 3 means "meaningfully better than the
// bare minimum on cost, latency, and drop rate all at once," not "perfect."
const THREE_STAR_COMPOSITE = 0.8;
const TWO_STAR_COMPOSITE = 0.5;

/**
 * 1 = actual is 0 (as good as this axis can be), 0 = actual is right at
 * the pass bar. Scaling against the bar itself — rather than inventing a
 * separate "excellent" threshold per scenario — keeps every scenario's
 * star math derivable from numbers it already has to define anyway (its
 * existing constraints + budgetUsd), no extra tuning knob to author or
 * verify per scenario.
 */
function headroom(actual: number, bar: number): number {
  if (bar <= 0) return 0;
  return Math.max(0, Math.min(1, (bar - actual) / bar));
}

interface BaseScore {
  evaluation: ScenarioEvaluation;
  actualCostUsd: number;
  budgetUsd: number | null;
  budgetPassed: boolean;
  architectureValid: boolean;
  gatesPassed: boolean;
  composite: number;
  stars: 0 | 1 | 2 | 3;
}

/** The 0-3 star computation alone, with no knowledge of optimalSolution — kept separate so computeOptimalScore (below) can call it without recursing back into the legendary check. */
function computeBaseScore(
  scenario: Scenario,
  result: SimulationResult,
  nodes: ArchitectureNode[],
  connections: { source: EntityId; target: EntityId }[],
  ignoreBudget: boolean
): BaseScore {
  const evaluation = evaluateScenario(scenario, result.metrics);
  const cost = estimateCost(result, nodes);
  const budgetUsd = ignoreBudget ? null : (scenario.budgetUsd ?? null);
  const budgetPassed = budgetUsd === null || cost.totalMonthlyCost <= budgetUsd;
  const architectureValid =
    !hasUnguardedBackendAccess(nodes, connections) &&
    (!scenario.requiresGatedToolCalls || !hasUnguardedIrreversibleAction(nodes, connections));
  const gatesPassed = evaluation.passed && budgetPassed && architectureValid;

  if (!gatesPassed) {
    return {
      evaluation,
      actualCostUsd: cost.totalMonthlyCost,
      budgetUsd,
      budgetPassed,
      architectureValid,
      gatesPassed: false,
      composite: 0,
      stars: 0,
    };
  }

  const p95Constraint = scenario.constraints.find((c) => c.metric === "p95Latency");
  const successConstraint = scenario.constraints.find((c) => c.metric === "successRate");

  const costScore = budgetUsd !== null ? headroom(cost.totalMonthlyCost, budgetUsd) : 1;
  const latencyScore = p95Constraint
    ? headroom(result.metrics.p95Latency, p95Constraint.threshold)
    : 1;
  const dropRateBar = successConstraint ? 1 - successConstraint.threshold : 0;
  const actualDropRate = 1 - result.metrics.successRate;
  const dropScore = successConstraint ? headroom(actualDropRate, dropRateBar) : 1;

  const composite = (costScore + latencyScore + dropScore) / 3;
  const stars: 0 | 1 | 2 | 3 =
    composite >= THREE_STAR_COMPOSITE ? 3 : composite >= TWO_STAR_COMPOSITE ? 2 : 1;

  return {
    evaluation,
    actualCostUsd: cost.totalMonthlyCost,
    budgetUsd,
    budgetPassed,
    architectureValid,
    gatesPassed: true,
    composite,
    stars,
  };
}

function fakeNode(id: string, type: EntityType, config: Record<string, unknown>): ArchitectureNode {
  return {
    id,
    type: "component",
    position: { x: 0, y: 0 },
    data: { entityType: type, label: id, config },
  } as unknown as ArchitectureNode;
}

// `${scenario.id}:${ignoreBudget}` -> the reference build's own
// BaseScore, computed once per (scenario, budget-checking-on-or-off)
// pair. Safe to cache module-wide: an OptimalSolution is static authored
// data (same entities/connections/seed every time), so its score never
// changes within a session for a given `ignoreBudget` value —
// recomputing it on every single scoreScenario call (i.e. every playback
// frame) would mean re-running the simulation engine constantly for no
// reason. Keyed by both, not just scenario.id, so toggling budget
// checking mid-session can't read a stale score computed under the
// other setting.
const optimalScoreCache = new Map<string, BaseScore | null>();

function computeOptimalScore(scenario: Scenario, ignoreBudget: boolean): BaseScore | null {
  if (!scenario.optimalSolution) return null;
  const cacheKey = `${scenario.id}:${ignoreBudget}`;
  const cached = optimalScoreCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const { entities, connections } = scenario.optimalSolution;
  const config: SimulationConfig = {
    entities: entities.map(({ id, type, position, config }) => ({ id, type, position, config })),
    connections,
    scenario: {
      id: scenario.id,
      title: scenario.title,
      trafficPattern: scenario.trafficPattern,
      durationMs: scenario.durationMs,
    },
    options: { seed: scenario.seed },
  };
  const result = runSimulation(config);
  const nodes = entities.map((e) => fakeNode(e.id, e.type, e.config));
  const score = computeBaseScore(scenario, result, nodes, connections, ignoreBudget);
  optimalScoreCache.set(cacheKey, score);
  return score;
}

export function scoreScenario(
  scenario: Scenario,
  result: SimulationResult,
  nodes: ArchitectureNode[],
  connections: { source: EntityId; target: EntityId }[],
  /** When true, `scenario.budgetUsd` is treated as absent for both this build's own gate/composite AND the reference solution's — see workshopStore.ts's `budgetCheckingEnabled`. Defaults false (today's behavior, budget always counted) so every existing call site keeps working unchanged. */
  ignoreBudget = false
): ScenarioScore {
  const base = computeBaseScore(scenario, result, nodes, connections, ignoreBudget);
  const optimal = computeOptimalScore(scenario, ignoreBudget);
  const optimalComposite = optimal?.gatesPassed ? optimal.composite : null;

  const legendary =
    base.gatesPassed && optimalComposite !== null && base.composite > optimalComposite;

  return {
    ...base,
    stars: legendary ? 5 : base.stars,
    legendary,
    optimalComposite,
  };
}
