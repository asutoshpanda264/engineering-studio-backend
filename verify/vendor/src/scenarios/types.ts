/**
 * Shared type definitions for the scenario system.
 * Zero React/Zustand imports — a Scenario should be evaluable in a unit
 * test the same way the simulation engine is (ADR-001's reasoning applies
 * here too: testability, reuse, a clean boundary). It depends only on the
 * simulation engine's own stable contract (EntityConfig, ConnectionConfig,
 * TrafficPattern, MetricsSnapshot).
 *
 * Per SCENARIOS.md, a scenario is "a business problem, not a technology" —
 * this shape captures the Story, the Starting Point, and the Constraints
 * (its Success Criteria) parts of that document's six-part anatomy.
 * Reflection and mid-run Challenges (traffic spikes, injected failures)
 * are deferred until a scenario actually needs them.
 */

import type {
  ConnectionConfig,
  EntityId,
  EntityType,
  MetricsSnapshot,
  TrafficPattern,
} from "@/simulation/types";

/**
 * One node in a scenario's starting architecture. Same shape the engine
 * already consumes (EntityConfig) plus a display label, since the
 * Workshop needs a name to put on the node — the engine itself doesn't
 * care about labels.
 */
export interface ScenarioEntity {
  id: EntityId;
  type: EntityType;
  label: string;
  position: { x: number; y: number };
  config: Record<string, unknown>;
}

/**
 * Metrics a constraint can be checked against. Deliberately a subset of
 * MetricsSnapshot's keys — only the scalar, top-level numbers a success
 * criterion would reasonably threshold against (not entityMetrics, which
 * is per-node and needs a different shape of constraint entirely).
 */
export type ScenarioMetric =
  | "successRate"
  | "averageLatency"
  | "p95Latency"
  | "p99Latency"
  | "throughput"
  | "failedRequests"
  | "totalIterations"
  | "guardrailRejectionRate";

export type Comparator = "lt" | "lte" | "gt" | "gte";

/**
 * What a scenario is *about*, for browsing/filtering the growing catalogue
 * (a "Problems" list, LeetCode-tag-style) — orthogonal to `difficulty`,
 * which is how hard it is, not what it teaches. One entity type each,
 * except `system-design`: a scenario that's a genuine multi-entity
 * capstone (the four "given + budget" scenarios today) rather than one
 * mechanism applied in isolation. A scenario can carry several — most
 * naturally touch more than one concept — so `Scenario.topics` is an
 * array, unlike `LLDCategory` (`src/content/lld/types.ts`), which is
 * singular because each LLD lesson sits in exactly one interview phase.
 */
export type ScenarioTopic =
  | "load-balancing"
  | "caching"
  | "cdn"
  | "rate-limiting"
  | "circuit-breakers"
  | "message-queues"
  | "kafka"
  | "replication"
  | "reverse-proxy"
  | "system-design"
  // docs/Agentic_AI.md Part 4 — the agentic domain's own topic set,
  // mirroring the "one entity/mechanism each, plus a capstone label"
  // shape the HLD topics above already establish (system-design's
  // agentic sibling is agentic-system-design, not a reused label — these
  // are two structurally different sandboxes, see entityCatalog.ts's own
  // `domain` field, and conflating their catalogues would blur two
  // unrelated curricula into one filter).
  | "tool-use"
  | "human-in-the-loop"
  | "retrieval"
  | "multi-agent-orchestration"
  | "model-routing"
  | "agentic-system-design";

export const SCENARIO_TOPIC_LABEL: Record<ScenarioTopic, string> = {
  "load-balancing": "Load Balancing",
  caching: "Caching",
  cdn: "CDN",
  "rate-limiting": "Rate Limiting",
  "circuit-breakers": "Circuit Breakers",
  "message-queues": "Message Queues",
  kafka: "Kafka",
  replication: "Replication",
  "reverse-proxy": "Reverse Proxy",
  "system-design": "System Design",
  "tool-use": "Tool Use",
  "human-in-the-loop": "Human-in-the-Loop",
  retrieval: "Retrieval",
  "multi-agent-orchestration": "Multi-Agent Orchestration",
  "model-routing": "Model Routing",
  "agentic-system-design": "Agentic System Design",
};

/**
 * A single success criterion. Kept as declarative data (metric +
 * comparator + threshold) rather than a predicate closure — per
 * TECHNICAL-SPECIFICATION.md, "configuration should remain declarative,
 * never executable." That also means the Inspector can render every
 * constraint generically ("p95 latency < 300ms: 214ms — pass") without a
 * switch statement per scenario.
 */
export interface ScenarioConstraint {
  id: string;
  metric: ScenarioMetric;
  comparator: Comparator;
  threshold: number;
  label: string;
  unit?: string;
}

/**
 * A prediction exercise answerable with arithmetic from the scenario's own
 * starting config (PRIMER-GAP.md Part A) — asked *before* a run, not
 * exposition read beforehand. `worked` is revealed on request, same
 * "questions teach, answers merely solve" reasoning as `hints`: it isn't
 * checked against a student's answer, it's the reasoning trail made
 * visible once they've made their own guess.
 */
export interface CapacityEstimate {
  prompt: string;
  worked: string;
}

/**
 * Shown once a run completes, regardless of pass or fail — SCENARIOS.md
 * §5's "Reflection" anatomy piece. `template` is resolved against the
 * run's own MetricsSnapshot via `resolveReflection`, kept declarative
 * like ScenarioConstraint (TECHNICAL-SPECIFICATION.md: "configuration
 * should remain declarative, never executable") rather than a
 * predicate/formatter function per scenario. Placeholders are
 * `{{metricName}}` for any ScenarioMetric key.
 */
export interface ScenarioReflection {
  template: string;
}

/**
 * A strong, hand-tuned (not proven-maximal) reference architecture a
 * student can reveal if stuck — the "give up and see an answer" end of the
 * same progressive-disclosure spirit `hints` already uses, just one step
 * further than SCENARIOS.md's Hints philosophy ("encourage thinking, not
 * provide solutions") normally goes, by explicit request. Revealing it
 * loads it directly onto the canvas (see `loadOptimalSolution` in
 * workshopStore.ts) rather than just describing it in prose — a full
 * architecture is a graph, not a sentence, and the canvas is this app's
 * own source of truth for what a "solution" even looks like.
 *
 * Deliberately *not* claimed to be the true optimum — `src/lib/
 * scenarioScoring.ts` scores it with the exact same `scoreScenario`
 * function used on a student's own build, and a build that beats its
 * composite score earns the "legendary" tier specifically *because*
 * beating a real, concrete number (not an assumed ceiling) is possible.
 * Verified against the real engine before shipping, same discipline as
 * every other tuned number in this codebase — see movieTicketBooking.ts's
 * own header comment for what was measured.
 */
export interface OptimalSolution {
  /** One or two sentences on the key idea — shown before it's revealed, so the reveal itself isn't the first hint of what to look for. */
  summary: string;
  /**
   * The full walkthrough for the `/problems/[id]/solution` editorial page
   * — one paragraph per idea (why this shape, what each entity buys,
   * the common wrong answer), student-facing prose distilled from the
   * same reasoning already verified against the real engine in this
   * scenario file's own header comment. Not shown until a student has
   * at least attempted the scenario (see the catalogue's own gating).
   */
  editorial: string[];
  entities: ScenarioEntity[];
  connections: ConnectionConfig[];
}

export interface Scenario {
  id: string;
  title: string;
  difficulty: 1 | 2 | 3 | 4 | 5;
  /** What this scenario is about, for the Problems catalogue's topic filter — see `ScenarioTopic`'s own doc. */
  topics: ScenarioTopic[];
  /**
   * Suggested countdown for Timed Challenge mode, in minutes. Optional —
   * when absent, the UI falls back to a difficulty-based default rather
   * than every scenario needing to pick a number up front.
   */
  suggestedTimeLimitMinutes?: number;
  /** The business problem (SCENARIOS.md §1 — "Story"). Technology-free. */
  story: string;
  /**
   * The problem's fixed "givens" — usually just a Client whose traffic the
   * student must serve, occasionally a mandated fixed-spec component they
   * must integrate with but can't resize (see `lockedFields`/`givenNodeIds`
   * below). Everything else is deliberately absent: the student designs the
   * rest of the architecture from a blank canvas, the same free-build
   * experience the Workshop offers outside of scenario mode — a scenario
   * should constrain the *problem*, not hand over a pre-built *solution*
   * with one dial left to turn (see docs/scenarios.md §3's updated
   * "Starting Point" section for the reasoning behind this change).
   */
  startingEntities: ScenarioEntity[];
  startingConnections: ConnectionConfig[];
  trafficPattern: TrafficPattern;
  durationMs: number;
  seed: number;
  /** Success criteria (SCENARIOS.md §2 — "Constraints"). */
  constraints: ScenarioConstraint[];
  /**
   * Ids (from `startingEntities`) the student cannot delete or replace.
   * Deleting a given node and dropping in a fresh, unlocked one would be a
   * loophole around `lockedFields` below, so the lock covers the node's
   * existence too, not just its config. Every id here should also appear
   * as a key in `lockedFields` (a given node with nothing locked on it
   * isn't really "given" — it's just a starting node, which this model
   * otherwise avoids).
   */
  givenNodeIds?: EntityId[];
  /**
   * Per given node, which config keys are read-only in the Inspector
   * because changing them would redefine the problem rather than solve it
   * (e.g. the Client's own `requestRate` — the demand the student is
   * building for, not a lever). Keys not listed remain editable even on a
   * given node, for the rarer "mandated component" case where only some of
   * its fields are fixed.
   */
  lockedFields?: Record<EntityId, string[]>;
  /**
   * Hard monthly cost ceiling ($), checked the same way as any other
   * constraint (via `scoreScenario` in `src/lib/scenarioScoring.ts`, since
   * cost needs the live canvas' nodes, not just a MetricsSnapshot — see
   * that file for why it can't live in this framework-independent module).
   * A solution over budget hasn't solved the scenario, regardless of how
   * good its latency/success-rate numbers are. Undefined means no budget
   * gate — not every scenario needs one, though most under the new model
   * should (see movieTicketBooking.ts for the reference implementation).
   */
  budgetUsd?: number;
  /**
   * `docs/Agentic_AI.md` §2.1/Part 4's reversibility-weighted-risk gate —
   * checked the same way as `hasUnguardedBackendAccess` (via
   * `src/lib/scenarioScoring.ts`, since it needs the live canvas' nodes,
   * not just a MetricsSnapshot). When true, a build where any Client
   * traffic can reach a `tool_call` without first passing through a
   * `human_in_loop_gate` hasn't solved the scenario, regardless of its
   * metrics — see `hasUnguardedIrreversibleAction` in
   * `architectureValidation.ts`. Undefined/false means no gate — every
   * scenario before this field existed keeps its exact prior behavior.
   */
  requiresGatedToolCalls?: boolean;
  /** Socratic questions, never answers (SCENARIOS.md — "Hints"). */
  hints: string[];
  /** What a student should leave understanding (SCENARIOS.md §6). */
  learningGoals: string[];
  /** Optional — not every scenario has one yet (PRIMER-GAP.md Part A). */
  capacityEstimate?: CapacityEstimate;
  /** Optional — not every scenario has one yet (PRIMER-GAP.md Part A). */
  reflection?: ScenarioReflection;
  /** Optional — a revealable reference build + the "legendary" tier for beating it. See OptimalSolution's own doc. */
  optimalSolution?: OptimalSolution;
}

/**
 * `totalIterations`/`guardrailRejectionRate` are `number | undefined` on
 * MetricsSnapshot (absent when the run has no Agent Orchestrator/
 * Guardrail Validator entities at all — see MetricsCollector.ts). A
 * scenario that constrains either one only makes sense once its own
 * `startingEntities`/story guarantees the relevant entity type exists, so
 * "absent" and "genuinely zero" collapse to the same reading here: no
 * orchestrator ever ran means 0 iterations, not "unknown."
 */
export function readScenarioMetric(
  metrics: MetricsSnapshot,
  metric: ScenarioMetric
): number {
  return metrics[metric] ?? 0;
}

const METRIC_PLACEHOLDER = /\{\{(\w+)\}\}/g;
const SCENARIO_METRIC_KEYS: readonly ScenarioMetric[] = [
  "successRate",
  "averageLatency",
  "p95Latency",
  "p99Latency",
  "throughput",
  "failedRequests",
  "totalIterations",
  "guardrailRejectionRate",
];

function isScenarioMetric(key: string): key is ScenarioMetric {
  return (SCENARIO_METRIC_KEYS as readonly string[]).includes(key);
}

function formatMetricPlaceholder(metric: ScenarioMetric, value: number): string {
  if (metric === "successRate" || metric === "guardrailRejectionRate") {
    return `${(value * 100).toFixed(1)}%`;
  }
  if (metric === "throughput") return `${value.toFixed(1)} req/s`;
  if (metric === "totalIterations") return String(Math.round(value));
  if (metric.toLowerCase().includes("latency")) return `${Math.round(value)}ms`;
  return value.toFixed(1);
}

/**
 * Fills a ScenarioReflection's `{{metric}}` placeholders against a real,
 * completed run's metrics. An unrecognized placeholder is left literal
 * rather than throwing — a typo in scenario content should surface as an
 * obviously-wrong string in the UI, not crash the Inspector.
 */
export function resolveReflection(
  reflection: ScenarioReflection,
  metrics: MetricsSnapshot
): string {
  return reflection.template.replace(METRIC_PLACEHOLDER, (match, key: string) => {
    if (!isScenarioMetric(key)) return match;
    return formatMetricPlaceholder(key, readScenarioMetric(metrics, key));
  });
}
