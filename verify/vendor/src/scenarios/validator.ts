/**
 * Checks a completed simulation run against a scenario's constraints.
 *
 * Deliberately separate from the simulation engine: a scenario is a
 * judgment about an architecture's results, not part of computing those
 * results (SIMULATION-ENGINE.md §10 — metrics are discovered by the
 * engine; a scenario only interprets numbers that already exist).
 *
 * Zero React imports.
 */

import type { MetricsSnapshot } from "@/simulation/types";
import type { Comparator, Scenario, ScenarioConstraint } from "./types";
import { readScenarioMetric } from "./types";

export interface ConstraintResult {
  constraint: ScenarioConstraint;
  actual: number;
  passed: boolean;
}

export interface ScenarioEvaluation {
  passed: boolean;
  results: ConstraintResult[];
}

function compare(actual: number, comparator: Comparator, threshold: number): boolean {
  switch (comparator) {
    case "lt":
      return actual < threshold;
    case "lte":
      return actual <= threshold;
    case "gt":
      return actual > threshold;
    case "gte":
      return actual >= threshold;
  }
}

export function evaluateConstraint(
  constraint: ScenarioConstraint,
  metrics: MetricsSnapshot
): ConstraintResult {
  const actual = readScenarioMetric(metrics, constraint.metric);
  return {
    constraint,
    actual,
    passed: compare(actual, constraint.comparator, constraint.threshold),
  };
}

export function evaluateScenario(
  scenario: Scenario,
  metrics: MetricsSnapshot
): ScenarioEvaluation {
  const results = scenario.constraints.map((constraint) =>
    evaluateConstraint(constraint, metrics)
  );
  return {
    passed: results.every((r) => r.passed),
    results,
  };
}
