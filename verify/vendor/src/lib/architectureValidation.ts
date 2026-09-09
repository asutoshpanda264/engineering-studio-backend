/**
 * Generic architecture-shape gate for `scenarioScoring.ts` — separate from
 * the pass/fail constraints (`scenarios/validator.ts`, a MetricsSnapshot
 * check) and the budget gate (cost, from live canvas config). This one
 * asks a structural question neither of those can: did a Client's traffic
 * ever reach a storage/broker entity without passing through an actual
 * service layer first?
 *
 * Found live while tuning the URL Shortener scenario (see
 * docs/scenario-redesign.md): nothing stops wiring a Client straight to a
 * Database or Cache, skipping the API Server entirely. Because API pricing
 * (costEngine.ts) is the one meaningfully-priced "compute" tier, deleting
 * it is — perversely — the cheapest, fastest way to "solve" every one of
 * these budget-gated scenarios, with zero design effort. Confirmed this
 * wasn't scenario-specific: the exact same shortcut also beats the
 * already-shipped Movie Ticket Booking's `optimalSolution` and earns
 * "legendary" against it. A real gap in the shared scoring machinery, not
 * a number to retune per scenario — see this repo's own scenario-redesign.md
 * §2 for why a scenario-specific fix would have been the wrong layer.
 *
 * The rule: a raw storage/broker entity (Database, Cache, Message Queue,
 * Kafka, Replica Pool) must never be reachable from a Client without first
 * passing through an API Server. Front-line, client-facing entities (Load
 * Balancer, CDN, Reverse Proxy, Rate Limiter, Circuit Breaker) are NOT
 * barriers and are NOT backend types — real traffic legitimately passes
 * through or terminates at them without an API Server (a CDN fronting
 * static assets, a rate limiter guarding an API it sits in front of, etc).
 * Only "this is where a real business either processes a request or
 * persists/queues something" counts.
 */

import type { ArchitectureNode } from "@/store/workshopStore";
import type { EntityId, EntityType } from "@/simulation/types";

/**
 * Entity types that represent persistent storage or a message broker —
 * never meant to face a raw Client directly. Deliberately excludes
 * load_balancer/cdn/reverse_proxy/rate_limiter/circuit_breaker/replica_pool's
 * own leader-vs-replica routing nuance — those are legitimate front-line or
 * pass-through entities, not the thing this gate is protecting.
 */
const BACKEND_ENTITY_TYPES: ReadonlySet<EntityType> = new Set([
  "database",
  "cache",
  "message_queue",
  "kafka",
  "replica_pool",
]);

/**
 * The agentic domain's own "real service layer" — `docs/Agentic_AI.md`
 * §2.9's semantic-caching composition (`Cache` wired directly in front of
 * an `llm_call`/`model_router`, no `api` anywhere in the build) is a
 * legitimate, explicitly-designed pattern this HLD-era check would
 * otherwise misread as the same "Client hit raw storage" exploit it was
 * built to catch. These types stand in for "api" specifically as the
 * thing that makes a `cache` sitting directly off a Client legitimate —
 * see the `cache`-specific carve-out below. They are NOT added to
 * `BACKEND_ENTITY_TYPES`'s own barrier check (the plain `if (type ===
 * "api") continue` below stays HLD-only) since none of these primitives
 * are themselves "raw storage" a Client could exploit; the concern this
 * function protects against simply doesn't apply to them directly.
 */
const AGENTIC_SERVICE_LAYER_TYPES: ReadonlySet<EntityType> = new Set([
  "llm_call",
  "tool_call",
  "agent_orchestrator",
  "retriever",
  "guardrail_validator",
  "model_router",
  "human_in_loop_gate",
  "memory_context_store",
]);

interface MinimalConnection {
  source: EntityId;
  target: EntityId;
}

/**
 * True when some Client's traffic can reach a backend entity type without
 * passing through an "api" entity first. Implemented as a barrier BFS from
 * every Client node: expansion stops at any "api" node (everything past a
 * real service layer is out of scope for this check — it's already
 * guarded), so only the portion of the graph reachable *before* hitting an
 * API is inspected for a backend type sitting in it.
 */
export function hasUnguardedBackendAccess(
  nodes: ArchitectureNode[],
  connections: MinimalConnection[]
): boolean {
  const typeById = new Map(nodes.map((n) => [n.id, n.data.entityType]));
  const adjacency = new Map<EntityId, EntityId[]>();
  for (const { source, target } of connections) {
    const list = adjacency.get(source);
    if (list) list.push(target);
    else adjacency.set(source, [target]);
  }

  const clientIds = nodes.filter((n) => n.data.entityType === "client").map((n) => n.id);
  const visited = new Set<EntityId>();
  const queue: EntityId[] = [...clientIds];

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);

    const type = typeById.get(id);
    if (type === "api") continue; // barrier — don't look past a real service layer
    if (type === "cache" && !clientIds.includes(id)) {
      // §2.9's semantic-caching carve-out: a Cache sitting directly off a
      // Client is only the HLD "skip the API" exploit when nothing real
      // is behind it. When it forwards straight into the agentic
      // domain's own service layer (an llm_call, a model_router, ...),
      // it's the documented cache-aside-in-front-of-an-llm_call pattern
      // instead — legitimate, not a violation. A dead end or a forward
      // into raw storage still falls through to the generic check below.
      const downstream = adjacency.get(id) ?? [];
      const hasLegitimateTarget = downstream.some((next) => {
        const nextType = typeById.get(next);
        return nextType === "api" || (nextType && AGENTIC_SERVICE_LAYER_TYPES.has(nextType));
      });
      if (hasLegitimateTarget) continue;
      return true;
    }
    if (type && BACKEND_ENTITY_TYPES.has(type) && !clientIds.includes(id)) {
      return true;
    }

    for (const next of adjacency.get(id) ?? []) {
      if (!visited.has(next)) queue.push(next);
    }
  }

  return false;
}

/**
 * `docs/Agentic_AI.md` Part 4's reversibility-weighted-risk gate — the
 * agentic-domain sibling to `hasUnguardedBackendAccess` above, same
 * barrier-BFS shape: expansion stops at any `human_in_loop_gate` node
 * (everything past a real approval gate is out of scope — it's already
 * guarded), so only the portion of the graph reachable *before* an
 * approval gate is inspected for a `tool_call` sitting in it. A
 * `tool_call` is this domain's stand-in for "the thing that actually
 * performs an action" — the scenarios that opt into this check (§2.1's
 * customer-support/coding-agent/autonomous-ops-agent scenarios) are all
 * built entirely from a single tool_call representing the one
 * irreversible action the story is about, so "every tool_call must be
 * gated" is the right generalization here, unlike `BACKEND_ENTITY_TYPES`
 * above which needed a whole set of types.
 */
export function hasUnguardedIrreversibleAction(
  nodes: ArchitectureNode[],
  connections: MinimalConnection[]
): boolean {
  const typeById = new Map(nodes.map((n) => [n.id, n.data.entityType]));
  const adjacency = new Map<EntityId, EntityId[]>();
  for (const { source, target } of connections) {
    const list = adjacency.get(source);
    if (list) list.push(target);
    else adjacency.set(source, [target]);
  }

  const clientIds = nodes.filter((n) => n.data.entityType === "client").map((n) => n.id);
  const visited = new Set<EntityId>();
  const queue: EntityId[] = [...clientIds];

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);

    const type = typeById.get(id);
    if (type === "human_in_loop_gate") continue; // barrier — don't look past a real approval gate
    if (type === "tool_call") return true;

    for (const next of adjacency.get(id) ?? []) {
      if (!visited.has(next)) queue.push(next);
    }
  }

  return false;
}
