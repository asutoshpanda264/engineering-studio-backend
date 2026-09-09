/**
 * Estimates a realistic $/month infrastructure cost per entity, derived
 * purely from its config + the last run's metrics — same shape as
 * suggestionEngine.ts (a pure function over SimulationResult + nodes, no
 * simulation-engine changes).
 *
 * CDN.ts's own class doc already names "a cost calculator" as a real,
 * deferred follow-up, separate from CDN's entity behavior. This is that
 * follow-up, generalized to every priced entity: API Server, Database,
 * Cache, CDN, Load Balancer, Message Queue. Client is excluded — it's the
 * traffic source, not infrastructure the user provisions.
 *
 * Every entity's monthly cost is base (provisioned capacity, from its own
 * config field — charged whether or not it saw traffic, same as real
 * infra) + usage (from monthly request/message volume, extrapolated from
 * the simulated rate). That base/usage split mirrors how cloud billing
 * actually works — EC2/RDS/ElastiCache bill for what you provisioned,
 * Lambda/SQS/CloudFront bill for what you actually used — which is itself
 * worth surfacing, not just an implementation detail.
 *
 * Every dollar figure here is an illustrative, rounded stand-in for
 * genuine public on-demand cloud pricing (roughly 2024, us-east-1-ish) —
 * directional, not a quote. Documented per entity below.
 */

import type { EntityId, EntityType, SimulationResult } from "@/simulation/types";
import type { ArchitectureNode } from "@/store/workshopStore";
import { ENTITY_CONFIG_SCHEMA } from "@/lib/entityConfigSchema";

export type CostSeverity = "normal" | "elevated" | "high";

export interface EntityCostEstimate {
  entityId: EntityId;
  entityType: EntityType;
  monthlyBaseCost: number;
  monthlyUsageCost: number;
  monthlyTotalCost: number;
  monthlyRequestVolume: number;
  severity: CostSeverity;
  /**
   * False when there's no SimulationResult yet — monthlyUsageCost is a
   * real 0 in that case, not "no traffic reached it," and the UI should
   * say so rather than implying usage was measured and came out to
   * nothing. monthlyBaseCost is always real either way: it comes purely
   * from provisioned config (maxConcurrent, capacity, ...), never from
   * traffic, so a real cloud bill for this config would include it
   * before a single request ever arrives.
   */
  hasUsageData: boolean;
}

export interface ArchitectureCostEstimate {
  /** Client nodes excluded — see class doc. */
  entities: EntityCostEstimate[];
  totalMonthlyCost: number;
  /** Worst severity among all entities; "normal" if there are none. */
  severity: CostSeverity;
}

const HOURS_PER_MONTH = 730; // standard cloud-billing month, same convention AWS/GCP calculators use
const SECONDS_PER_MONTH = HOURS_PER_MONTH * 3600;

/** Same fallback ConfigField itself uses — node.data.config isn't merged with schema defaults upstream. */
function configNumber(node: ArchitectureNode, key: string, fallback: number): number {
  const raw = node.data.config[key];
  return typeof raw === "number" ? raw : fallback;
}

/** Select-field counterpart of configNumber — for the string-valued dials (tier, quantization, deploymentTarget, ...). */
function configString(node: ArchitectureNode, key: string, fallback: string): string {
  const raw = node.data.config[key];
  return typeof raw === "string" ? raw : fallback;
}

function defaultFor(entityType: EntityType, key: string): number {
  const field = ENTITY_CONFIG_SCHEMA[entityType]?.find((f) => f.key === key);
  return field && field.type !== "select" ? field.default : 0;
}

function defaultSelectFor(entityType: EntityType, key: string): string {
  const field = ENTITY_CONFIG_SCHEMA[entityType]?.find((f) => f.key === key);
  return field && field.type === "select" ? field.default : "";
}

/** requests/sec observed in the run, extrapolated to a monthly volume. */
function monthlyVolume(requestsInRun: number, durationMs: number): number {
  if (durationMs <= 0 || requestsInRun <= 0) return 0;
  const perSecond = requestsInRun / (durationMs / 1000);
  return perSecond * SECONDS_PER_MONTH;
}

interface SeverityThresholds {
  elevated: number;
  high: number;
}

// Every threshold below is calibrated against what THIS entity can
// actually reach given the app's own config/traffic ceilings (client
// Request Rate maxes at 1000 req/s; each entity's own capacity fields
// have their own schema max in entityConfigSchema.ts) — not generic
// "real production fleet" tiers, since a single modeled Cache/API/DB node
// here can never represent a whole fleet. A threshold a user's own
// sliders can never reach is a bug, not a conservative default (this is
// exactly the shape of bug the Cache divisor fix below corrects).
const SEVERITY_THRESHOLDS: Record<string, SeverityThresholds> = {
  api: { elevated: 300, high: 1000 },
  database: { elevated: 180, high: 500 },
  cache: { elevated: 50, high: 100 },
  cdn: { elevated: 300, high: 1500 },
  load_balancer: { elevated: 100, high: 400 },
  message_queue: { elevated: 150, high: 600 },
  llm_call: { elevated: 500, high: 2000 },
  tool_call: { elevated: 200, high: 800 },
  retriever: { elevated: 400, high: 1500 },
};

function severityFor(entityType: string, monthlyTotalCost: number): CostSeverity {
  const thresholds = SEVERITY_THRESHOLDS[entityType];
  if (!thresholds) return "normal";
  if (monthlyTotalCost > thresholds.high) return "high";
  if (monthlyTotalCost > thresholds.elevated) return "elevated";
  return "normal";
}

interface PricingResult {
  monthlyBaseCost: number;
  monthlyUsageCost: number;
  monthlyRequestVolume: number;
}

/**
 * `result` is nullable so every pricing model can run before a
 * simulation has ever happened — base cost only ever reads `node`'s own
 * config, never `result`, so it's always computable. Usage-cost lines
 * just read through optional chaining and fall back to the request
 * count/duration being 0, which `monthlyVolume` already treats as "no
 * usage" — no per-model null branching needed.
 */
type PricingModel = (
  node: ArchitectureNode,
  result: SimulationResult | null
) => PricingResult;

/**
 * API Server — base ≈ t3.medium on-demand ($0.0416/hr), one instance per
 * 5 units of Max Concurrent. Usage ≈ Lambda's per-request charge
 * ($0.20/1M). Known simplification: APIServer.ts routes both the inbound
 * request leg and the downstream response leg through the same
 * BoundedProcessor, so a functioning server's requestCount runs ~2x its
 * real client-facing volume — not worth correcting algorithmically
 * (fragile for failed/terminal cases), so this is illustrative, not
 * billing-API-accurate, same spirit as CDN.ts's own documented gaps.
 */
const apiPricing: PricingModel = (node, result) => {
  const maxConcurrent = configNumber(node, "maxConcurrent", defaultFor("api", "maxConcurrent"));
  const requestCount = result?.metrics.entityMetrics[node.id]?.requestCount ?? 0;
  const volume = monthlyVolume(requestCount, result?.duration ?? 0);

  return {
    monthlyBaseCost: Math.ceil(maxConcurrent / 5) * 0.0416 * HOURS_PER_MONTH,
    monthlyUsageCost: (volume / 1_000_000) * 0.2,
    monthlyRequestVolume: volume,
  };
};

/**
 * Database — base ≈ db.t3.medium on-demand ($0.07/hr), one instance per
 * 20 units of Max Connections. Usage ≈ Aurora's per-I/O-request charge
 * ($0.20/1M) — a real, distinct, per-request-billed line item for managed
 * relational databases, unlike Cache below (managed Redis bills purely by
 * node-hour, no per-op charge).
 */
const databasePricing: PricingModel = (node, result) => {
  const maxConnections = configNumber(
    node,
    "maxConnections",
    defaultFor("database", "maxConnections")
  );
  const requestCount = result?.metrics.entityMetrics[node.id]?.requestCount ?? 0;
  const volume = monthlyVolume(requestCount, result?.duration ?? 0);

  return {
    monthlyBaseCost: Math.ceil(maxConnections / 20) * 0.07 * HOURS_PER_MONTH,
    monthlyUsageCost: (volume / 1_000_000) * 0.2,
    monthlyRequestVolume: volume,
  };
};

/**
 * Cache — base ≈ cache.t3.micro tiers ($0.017/hr), one tier per 50 units
 * of Capacity (the schema caps Capacity at 500 — a /1000 divisor would
 * make every reachable config round to the same single tier, so this
 * uses /50 to keep the full 1-10 tier range reachable). No usage
 * component: managed Redis/ElastiCache bills by node-hour, not per-op.
 */
const cachePricing: PricingModel = (node) => {
  const capacity = configNumber(node, "capacity", defaultFor("cache", "capacity"));

  return {
    monthlyBaseCost: Math.ceil(capacity / 50) * 0.017 * HOURS_PER_MONTH,
    monthlyUsageCost: 0,
    monthlyRequestVolume: 0,
  };
};

/**
 * CDN — usage-only, no provisioned/base cost (real CDNs don't have one —
 * worth surfacing as its own lesson: this is *why* CDNs are attractive).
 * Priced like CloudFront: $0.085/GB egress (assuming 20KB/response, same
 * order of magnitude as the Load Balancer's assumed payload size below —
 * a large-media CDN would run far higher, but this simulator has no
 * concept of response size, so a small-payload assumption keeps the
 * severity curve comparably calibrated across entities) + $0.0075 per
 * 10,000 requests. Uses entityMetrics.cdnEdges (hits+misses
 * summed across every edge), NOT the raw requestCount — CDN.ts runs
 * PROCESSING_STARTED twice per miss (arrival + origin-response re-entry),
 * so requestCount double-counts misses; CACHE_HIT/CACHE_MISS (and
 * therefore cdnEdges) fires exactly once per request.
 */
const cdnPricing: PricingModel = (node, result) => {
  const cdnEdges = result?.metrics.entityMetrics[node.id]?.cdnEdges ?? [];
  const requests = cdnEdges.reduce((sum, edge) => sum + edge.requests, 0);
  const volume = monthlyVolume(requests, result?.duration ?? 0);
  const monthlyGB = (volume * 20_000) / 1_000_000_000; // 20KB assumed avg response size

  return {
    monthlyBaseCost: 0,
    monthlyUsageCost: monthlyGB * 0.085 + (volume / 10_000) * 0.0075,
    monthlyRequestVolume: volume,
  };
};

/**
 * Load Balancer — base ≈ ALB's flat hourly charge ($0.0225/hr); no
 * capacity config field exists to scale it on. Usage ≈ ALB's LCU-style
 * per-GB-processed charge ($0.008/GB, assuming 20KB/request). Uses
 * entityMetrics.routingDistribution directly (summed the same way
 * InspectorPanel.tsx already does) rather than requestCount — LoadBalancer.ts
 * has no BoundedProcessor and never emits PROCESSING_STARTED (it "has no
 * capacity of its own", per its own class doc). requestCount is no longer
 * unconditionally 0 here (MetricsCollector.ts now falls back to this same
 * routingDistribution sum when a request source's PROCESSING_STARTED count
 * is 0, so a router's requestCount and errorCount stay comparable — see
 * its comment), but this function still reads routingDistribution
 * directly rather than relying on that fallback, since it's the actual
 * source of truth this pricing model needs regardless of how
 * requestCount is derived.
 */
const loadBalancerPricing: PricingModel = (node, result) => {
  const distribution = result?.metrics.entityMetrics[node.id]?.routingDistribution ?? [];
  const requests = distribution.reduce((sum, target) => sum + target.requests, 0);
  const volume = monthlyVolume(requests, result?.duration ?? 0);
  const monthlyGB = (volume * 20_000) / 1_000_000_000; // 20KB assumed avg request size

  return {
    monthlyBaseCost: 0.0225 * HOURS_PER_MONTH,
    monthlyUsageCost: monthlyGB * 0.008,
    monthlyRequestVolume: volume,
  };
};

/**
 * Message Queue — usage-only, like CDN: real managed queues (SQS) have
 * no provisioned cost either. Priced at SQS's real $0.40 per million
 * requests. requestCount is safe to use as-is here — MessageQueue.ts's
 * admit-then-dispatch design was checked and confirmed to emit
 * PROCESSING_STARTED exactly once per admitted message, never twice.
 */
const messageQueuePricing: PricingModel = (node, result) => {
  const requestCount = result?.metrics.entityMetrics[node.id]?.requestCount ?? 0;
  const volume = monthlyVolume(requestCount, result?.duration ?? 0);

  return {
    monthlyBaseCost: 0,
    monthlyUsageCost: (volume / 1_000_000) * 0.4,
    monthlyRequestVolume: volume,
  };
};

/**
 * LlmCall — usage-only, like CDN/Message Queue: real LLM inference APIs
 * bill per-token, not per-provisioned-instance, so there's no base cost
 * (see §1.13's caching/cost-economics research this is grounded in).
 * $/1M-token rates vary by Model Tier (an SLM is dramatically cheaper —
 * §1.10's "90% of functionality at 10% of the cost") and are further
 * scaled by Quantization's cost multiplier (§1.11 — FP8/INT8/INT4 each
 * cut cost further, same direction as their latency win). Deployment
 * Target "edge" zeroes usage cost entirely: on-device inference has no
 * per-token API bill, you already own the hardware — the real economic
 * argument for edge deployment, not just the latency one.
 *
 * ASSUMED_TOKENS_PER_REQUEST stands in for this simulator having no real
 * token-count concept, same idiom CDN.ts's assumed 20KB response size
 * uses — illustrative, not measured. requestCount carries the same ~2x
 * over-count APIServer's does (both the request leg and the response leg
 * route through the one BoundedProcessor) — see apiPricing's comment;
 * accepted here for the same reason, not worth a fragile per-leg fix.
 */
const LLM_TIER_COST_PER_MILLION_TOKENS: Record<string, number> = {
  slm: 0.15,
  llm: 2.5,
};
const LLM_QUANTIZATION_COST_MULTIPLIER: Record<string, number> = {
  none: 1,
  fp8: 0.5,
  int8: 0.35,
  int4: 0.2,
};
const ASSUMED_TOKENS_PER_REQUEST = 800;

/**
 * docs/Agentic_AI.md §2.9's prompt caching — a provider caching a
 * previously-seen prompt prefix bills the cached portion at roughly this
 * fraction of the normal rate. Distinct from Cache.ts's semantic caching
 * (which skips the call entirely): this only discounts a call that still
 * happens. Applied as a blend — Prompt Cache Hit Rate's share of tokens
 * at the discount, the rest at full price — not an all-or-nothing switch.
 */
const PROMPT_CACHE_DISCOUNT = 0.1;

const llmCallPricing: PricingModel = (node, result) => {
  const requestCount = result?.metrics.entityMetrics[node.id]?.requestCount ?? 0;
  const volume = monthlyVolume(requestCount, result?.duration ?? 0);
  const deploymentTarget = configString(node, "deploymentTarget", defaultSelectFor("llm_call", "deploymentTarget"));

  if (deploymentTarget === "edge") {
    return { monthlyBaseCost: 0, monthlyUsageCost: 0, monthlyRequestVolume: volume };
  }

  const tier = configString(node, "tier", defaultSelectFor("llm_call", "tier"));
  const quantization = configString(node, "quantization", defaultSelectFor("llm_call", "quantization"));
  const promptCacheHitRate = configNumber(
    node,
    "promptCacheHitRate",
    defaultFor("llm_call", "promptCacheHitRate")
  );
  const promptCacheMultiplier = 1 - promptCacheHitRate * (1 - PROMPT_CACHE_DISCOUNT);
  const ratePerMillion =
    (LLM_TIER_COST_PER_MILLION_TOKENS[tier] ?? LLM_TIER_COST_PER_MILLION_TOKENS.llm) *
    (LLM_QUANTIZATION_COST_MULTIPLIER[quantization] ?? 1) *
    promptCacheMultiplier;
  const monthlyTokens = volume * ASSUMED_TOKENS_PER_REQUEST;

  return {
    monthlyBaseCost: 0,
    monthlyUsageCost: (monthlyTokens / 1_000_000) * ratePerMillion,
    monthlyRequestVolume: volume,
  };
};

/**
 * ToolCall — usage-only, priced directly off the node's own configured
 * Cost / Call (perCallCostUsd) — the flat-per-call shape real metered
 * third-party APIs actually bill under, unlike a provisioned-instance
 * cost.
 */
const toolCallPricing: PricingModel = (node, result) => {
  const perCallCostUsd = configNumber(node, "perCallCostUsd", defaultFor("tool_call", "perCallCostUsd"));
  const requestCount = result?.metrics.entityMetrics[node.id]?.requestCount ?? 0;
  const volume = monthlyVolume(requestCount, result?.duration ?? 0);

  return {
    monthlyBaseCost: 0,
    monthlyUsageCost: volume * perCallCostUsd,
    monthlyRequestVolume: volume,
  };
};

/**
 * Retriever — usage-only, like llm_call/tool_call: retrieval APIs bill
 * per-query, not per-provisioned-instance. Priced off the node's own
 * Cost / Query, scaled by a fixed per-mode multiplier: Agentic pays it
 * roughly once per attempt on average (a request that needed 2-3 tries
 * costs 2-3x a single Pipeline query); GraphRAG pays a flat premium
 * (graph traversal queries typically cost more per query than vector
 * search); Adaptive blends the two, weighted by an assumed relationship-
 * query fraction — illustrative, since a PricingModel only sees this one
 * node, not the Client's own Relationship Query Rate, same "a fixed
 * assumption stands in for something this simulator doesn't track
 * precisely" spirit as llmCallPricing's ASSUMED_TOKENS_PER_REQUEST.
 */
const RETRIEVER_MODE_COST_MULTIPLIER: Record<string, number> = {
  pipeline: 1,
  agentic: 1.8,
  graphrag: 2.5,
  adaptive: 1.3,
};

const retrieverPricing: PricingModel = (node, result) => {
  const requestCount = result?.metrics.entityMetrics[node.id]?.requestCount ?? 0;
  const volume = monthlyVolume(requestCount, result?.duration ?? 0);
  const mode = configString(node, "mode", defaultSelectFor("retriever", "mode"));
  const costPerQueryUsd = configNumber(node, "costPerQueryUsd", defaultFor("retriever", "costPerQueryUsd"));
  const multiplier = RETRIEVER_MODE_COST_MULTIPLIER[mode] ?? 1;

  return {
    monthlyBaseCost: 0,
    monthlyUsageCost: volume * costPerQueryUsd * multiplier,
    monthlyRequestVolume: volume,
  };
};

const PRICING_MODELS: Partial<Record<EntityType, PricingModel>> = {
  api: apiPricing,
  database: databasePricing,
  cache: cachePricing,
  cdn: cdnPricing,
  load_balancer: loadBalancerPricing,
  message_queue: messageQueuePricing,
  llm_call: llmCallPricing,
  tool_call: toolCallPricing,
  retriever: retrieverPricing,
};

/**
 * `result` is nullable on purpose — base cost (provisioned capacity, from
 * config alone) is real and displayable the moment a component exists on
 * the canvas, same as a real cloud bill starts before the first request
 * ever arrives. Only usage cost needs a completed run, since it's
 * extrapolated from observed traffic. Pass `null` to get every priced
 * entity's config-only estimate; pass the SimulationResult once one
 * exists to layer usage cost on top.
 */
export function estimateCost(
  result: SimulationResult | null,
  nodes: ArchitectureNode[]
): ArchitectureCostEstimate {
  const entities: EntityCostEstimate[] = [];

  for (const node of nodes) {
    const pricing = PRICING_MODELS[node.data.entityType];
    if (!pricing) continue; // client, or any not-yet-priced entity type

    const { monthlyBaseCost, monthlyUsageCost, monthlyRequestVolume } = pricing(node, result);
    const monthlyTotalCost = monthlyBaseCost + monthlyUsageCost;

    entities.push({
      entityId: node.id,
      entityType: node.data.entityType,
      monthlyBaseCost,
      monthlyUsageCost,
      monthlyTotalCost,
      monthlyRequestVolume,
      severity: severityFor(node.data.entityType, monthlyTotalCost),
      hasUsageData: result !== null,
    });
  }

  const severityRank: Record<CostSeverity, number> = { normal: 0, elevated: 1, high: 2 };
  const severity = entities.reduce<CostSeverity>(
    (worst, entity) => (severityRank[entity.severity] > severityRank[worst] ? entity.severity : worst),
    "normal"
  );

  return {
    entities,
    totalMonthlyCost: entities.reduce((sum, e) => sum + e.monthlyTotalCost, 0),
    severity,
  };
}
