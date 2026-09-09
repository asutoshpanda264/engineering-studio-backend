import { runSimulation } from "@/simulation/engine/Simulator";
import { scoreScenario } from "@/lib/scenarioScoring";
import type { ClientGraph } from "./graphAdapter.js";
import { toConnectionConfigs, toEntityConfigs, toFakeArchitectureNodes } from "./graphAdapter.js";

/**
 * The scenario body, as sent by the caller (Spring Boot) — matching the
 * frontend's own `Scenario` TS interface field-for-field (see
 * engineering-studio-api's ScenarioResponse, which mirrors it exactly).
 * This service is stateless and has no database of its own — Postgres,
 * via the calling API, stays the single source of truth for scenario
 * content; this service only ever computes with what it's handed. Typed
 * loosely (fields accessed via `as any` where the vendored functions need
 * their real Scenario shape) rather than re-declaring the whole interface
 * here — see decisions.md on why duplicating that type isn't worth it for
 * a single call site.
 */
export interface VerifyPayload {
  scenario: Record<string, unknown>;
  graph: ClientGraph;
}

export interface VerifyOutcome {
  metrics: unknown;
  evaluation: unknown;
  score: unknown;
}

export function verify(payload: VerifyPayload): VerifyOutcome {
  const { scenario, graph } = payload;

  const entities = toEntityConfigs(graph.nodes);
  const connections = toConnectionConfigs(graph.connections);
  const fakeNodes = toFakeArchitectureNodes(graph.nodes);

  const simulationConfig = {
    entities,
    connections,
    scenario: {
      id: scenario.id as string,
      title: scenario.title as string,
      trafficPattern: scenario.trafficPattern,
      durationMs: scenario.durationMs as number,
    },
    options: { seed: scenario.seed as number },
    // The vendored SimulationConfig type is stricter than this loosely-typed
    // payload — tsx transpiles without type-checking (see decisions.md), so
    // this is a deliberate, honest cast rather than an accidental hole.
  } as unknown as Parameters<typeof runSimulation>[0];

  const result = runSimulation(simulationConfig);

  const score = scoreScenario(
    scenario as unknown as Parameters<typeof scoreScenario>[0],
    result,
    fakeNodes as unknown as Parameters<typeof scoreScenario>[2],
    connections
  );

  return {
    metrics: result.metrics,
    evaluation: score.evaluation,
    score,
  };
}
