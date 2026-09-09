/**
 * The Simulator orchestrates the discrete-event loop:
 * take the next event, advance virtual time, deliver it, record whatever
 * new events result, repeat. (SIMULATION-ENGINE.md §8 — "The Simulation
 * Loop".) It never contains infrastructure behavior itself — that lives
 * entirely in the entities it delivers events to.
 *
 * Zero React dependencies.
 */

import { Clock } from "./Clock";
import { EventQueue } from "./EventQueue";
import { RNG } from "./RNG";
import {
  assignPhantomKey,
  assignRequestExistence,
  assignRequestKey,
  assignRequestRelationshipQuery,
  assignRequestRoute,
  generateArrivalTimestamps,
} from "./TrafficGenerator";
import {
  createEvent,
  createRequestStartedEvent,
  resetEventIds,
} from "../events/EventFactory";
import type { Entity, SimulationContext } from "../entities/Entity";
import { Client } from "../entities/Client";
import { APIServer } from "../entities/APIServer";
import { Database } from "../entities/Database";
import { LoadBalancer } from "../entities/LoadBalancer";
import { Cache } from "../entities/Cache";
import { CDN } from "../entities/CDN";
import { MessageQueue } from "../entities/MessageQueue";
import { RateLimiter } from "../entities/RateLimiter";
import { CircuitBreaker } from "../entities/CircuitBreaker";
import { ReplicaPool } from "../entities/ReplicaPool";
import { ReverseProxy } from "../entities/ReverseProxy";
import { Kafka } from "../entities/Kafka";
import { LlmCall } from "../entities/LlmCall";
import { ToolCall } from "../entities/ToolCall";
import { AgentOrchestrator } from "../entities/AgentOrchestrator";
import { MemoryContextStore } from "../entities/MemoryContextStore";
import { Retriever } from "../entities/Retriever";
import { GuardrailValidator } from "../entities/GuardrailValidator";
import { ModelRouter } from "../entities/ModelRouter";
import { HumanInLoopGate } from "../entities/HumanInLoopGate";
import { collectMetrics } from "../metrics/MetricsCollector";
import type {
  EntityConfig,
  EntityId,
  SimulationConfig,
  SimulationResult,
} from "../types";
import type { SimulationEvent } from "../events/types";

const DEFAULT_MAX_STEPS = 200_000;
const DEFAULT_KEY_POOL_SIZE = 50;
const DEFAULT_ROUTE_POOL_SIZE = 3;
const DEFAULT_MISSING_KEY_RATE = 0;
const DEFAULT_RELATIONSHIP_QUERY_RATE = 0;

function createEntity(config: EntityConfig): Entity | null {
  switch (config.type) {
    case "client":
      return new Client(config.id);
    case "api":
      return new APIServer(config.id, config.config);
    case "database":
      return new Database(config.id, config.config);
    case "load_balancer":
      return new LoadBalancer(config.id, config.config);
    case "cache":
      return new Cache(config.id, config.config);
    case "cdn":
      return new CDN(config.id, config.config);
    case "message_queue":
      return new MessageQueue(config.id, config.config);
    case "rate_limiter":
      return new RateLimiter(config.id, config.config);
    case "circuit_breaker":
      return new CircuitBreaker(config.id, config.config);
    case "replica_pool":
      return new ReplicaPool(config.id, config.config);
    case "reverse_proxy":
      return new ReverseProxy(config.id, config.config);
    case "kafka":
      return new Kafka(config.id, config.config);
    case "llm_call":
      return new LlmCall(config.id, config.config);
    case "tool_call":
      return new ToolCall(config.id, config.config);
    case "agent_orchestrator":
      return new AgentOrchestrator(config.id, config.config);
    case "memory_context_store":
      return new MemoryContextStore(config.id, config.config);
    case "retriever":
      return new Retriever(config.id, config.config);
    case "guardrail_validator":
      return new GuardrailValidator(config.id, config.config);
    case "model_router":
      return new ModelRouter(config.id, config.config);
    case "human_in_loop_gate":
      return new HumanInLoopGate(config.id, config.config);
    default:
      return null;
  }
}

export function runSimulation(config: SimulationConfig): SimulationResult {
  resetEventIds();
  let requestIdCounter = 0;

  const warnings: string[] = [];
  const errors: string[] = [];

  const entities = new Map<EntityId, Entity>();
  for (const entityConfig of config.entities) {
    const entity = createEntity(entityConfig);
    if (!entity) {
      warnings.push(
        `Entity type "${entityConfig.type}" is not implemented yet and was skipped (id: ${entityConfig.id}).`
      );
      continue;
    }
    entities.set(entity.id, entity);
  }

  // Routing topology is directional (only the connection's source may
  // forward to its target). Latency is a property of the physical link,
  // so it's looked up symmetrically — a response travels the same link
  // back at the same configured delay.
  const downstreamMap = new Map<EntityId, EntityId[]>();
  const latencyMap = new Map<EntityId, Map<EntityId, number>>();

  for (const connection of config.connections) {
    const list = downstreamMap.get(connection.source) ?? [];
    list.push(connection.target);
    downstreamMap.set(connection.source, list);

    const latency = connection.latencyMs ?? 0;
    setLatency(latencyMap, connection.source, connection.target, latency);
    setLatency(latencyMap, connection.target, connection.source, latency);
  }

  const clock = new Clock();
  const queue = new EventQueue();
  const rng = new RNG(config.options.seed);
  const allEvents: SimulationEvent[] = [];
  const maxSteps = config.options.maxSteps ?? DEFAULT_MAX_STEPS;

  queue.enqueue(createEvent("SIMULATION_STARTED", 0, null, null, null));

  const clientEntity = config.entities.find((e) => e.type === "client");
  if (!clientEntity) {
    warnings.push("No client entity found; no requests were generated.");
  } else {
    const keyPoolSize =
      typeof clientEntity.config.keyPoolSize === "number"
        ? clientEntity.config.keyPoolSize
        : DEFAULT_KEY_POOL_SIZE;
    const routePoolSize =
      typeof clientEntity.config.routePoolSize === "number"
        ? clientEntity.config.routePoolSize
        : DEFAULT_ROUTE_POOL_SIZE;
    const missingKeyRate =
      typeof clientEntity.config.missingKeyRate === "number"
        ? clientEntity.config.missingKeyRate
        : DEFAULT_MISSING_KEY_RATE;
    const relationshipQueryRate =
      typeof clientEntity.config.relationshipQueryRate === "number"
        ? clientEntity.config.relationshipQueryRate
        : DEFAULT_RELATIONSHIP_QUERY_RATE;

    const arrivals = generateArrivalTimestamps(
      config.scenario.trafficPattern,
      config.scenario.durationMs,
      rng
    );
    for (const timestamp of arrivals) {
      // Existence is decided before the key itself: a "missing" request
      // draws from assignPhantomKey's disjoint pool instead of the normal
      // assignRequestKey — see Cache.ts's Negative Caching for what reads
      // `exists`.
      const exists = assignRequestExistence(rng, missingKeyRate);
      queue.enqueue(
        createRequestStartedEvent(
          timestamp,
          clientEntity.id,
          `req_${++requestIdCounter}`,
          {
            key: exists ? assignRequestKey(rng, keyPoolSize) : assignPhantomKey(rng, keyPoolSize),
            route: assignRequestRoute(rng, routePoolSize),
            exists,
            requiresRelationshipTraversal: assignRequestRelationshipQuery(
              rng,
              relationshipQueryRate
            ),
          }
        )
      );
    }
  }

  let steps = 0;
  while (queue.hasEvents()) {
    if (++steps > maxSteps) {
      warnings.push(
        `Simulation stopped after reaching the ${maxSteps}-event safety limit.`
      );
      break;
    }

    const event = queue.dequeue();
    clock.advanceTo(event.timestamp);
    allEvents.push(event);

    if (event.type === "SIMULATION_STARTED") continue;

    const entity = event.destination ? entities.get(event.destination) : null;
    if (!entity) continue;

    const ctx: SimulationContext = {
      now: clock.now(),
      rng,
      downstream: downstreamMap.get(entity.id) ?? [],
      latencyTo: (targetId) => latencyMap.get(entity.id)?.get(targetId) ?? 0,
    };

    const newEvents = entity.handleEvent(event, ctx);
    for (const newEvent of newEvents) {
      queue.enqueue(newEvent);
    }
  }

  allEvents.push(
    createEvent("SIMULATION_FINISHED", clock.now(), null, null, null)
  );

  const clientIds = config.entities
    .filter((e) => e.type === "client")
    .map((e) => e.id);
  const agentOrchestratorIds = config.entities
    .filter((e) => e.type === "agent_orchestrator")
    .map((e) => e.id);
  const guardrailValidatorIds = config.entities
    .filter((e) => e.type === "guardrail_validator")
    .map((e) => e.id);

  const metrics = collectMetrics(
    allEvents,
    Array.from(entities.keys()),
    config.scenario.durationMs,
    clientIds,
    agentOrchestratorIds,
    guardrailValidatorIds
  );

  return {
    events: allEvents,
    metrics,
    duration: clock.now(),
    warnings,
    errors,
    clientIds,
    agentOrchestratorIds,
    guardrailValidatorIds,
    metadata: {
      seed: config.options.seed,
      version: "0.1.0",
      generatedAt: new Date().toISOString(),
    },
  };
}

function setLatency(
  map: Map<EntityId, Map<EntityId, number>>,
  from: EntityId,
  to: EntityId,
  latency: number
): void {
  const inner = map.get(from) ?? new Map<EntityId, number>();
  inner.set(to, latency);
  map.set(from, inner);
}
