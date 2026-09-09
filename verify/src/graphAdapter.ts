// Converts the client's submitted graph JSON — {nodes, connections}, the
// same shape the frontend's own Workshop canvas produces (ScenarioEntity[]
// / ConnectionConfig[], see the frontend's src/scenarios/types.ts) — into
// the two different node shapes the vendored engine functions expect:
//
//   runSimulation(config: SimulationConfig) wants config.entities as
//   EntityConfig[] = {id, type, position, config} — exactly what the
//   client already sends, no transformation needed.
//
//   scoreScenario(scenario, result, nodes, connections) wants
//   nodes: ArchitectureNode[] — a React Flow node type in the frontend
//   (Node<ComponentNodeData>, data nested under `.data.config`), but only
//   ever type-only imported by the vendored files (erased at transpile
//   time — see decisions.md) and only ever actually READ as
//   `.id`/`.type`/`.data.config[key]` at runtime. The frontend's own
//   scenarioScoring.ts already has an internal `fakeNode()` helper doing
//   exactly this reshaping for its optimalSolution scoring path — this is
//   the same trick, applied to student-submitted nodes instead.

export interface ClientEntity {
  id: string;
  type: string;
  position?: { x: number; y: number };
  config?: Record<string, unknown>;
}

export interface ClientConnection {
  source: string;
  target: string;
  latencyMs?: number;
  protocol?: string;
}

export interface ClientGraph {
  nodes: ClientEntity[];
  connections: ClientConnection[];
}

/** For runSimulation's SimulationConfig.entities — already the right shape, just defaulted/normalized. */
export function toEntityConfigs(nodes: ClientEntity[]) {
  return nodes.map((n) => ({
    id: n.id,
    type: n.type,
    position: n.position ?? { x: 0, y: 0 },
    config: n.config ?? {},
  }));
}

/**
 * The vendored functions type their `nodes` parameter as the frontend's
 * real `ArchitectureNode` (a React Flow `Node<ComponentNodeData>`) — but
 * that type is only ever `import type`-ed by them, so it's fully erased
 * before runtime (see this file's header comment) and never actually
 * resolved. Rather than reference that nonexistent path here too (even in
 * a type-only position), this local type declares exactly the shape
 * that's genuinely read at runtime — self-contained, nothing in this
 * service depends on React Flow existing.
 *
 * Mirrors `scenarioScoring.ts`'s own internal (unexported) `fakeNode()`
 * helper exactly, field for field — including the easy-to-get-wrong part:
 * `type` at the top level is a fixed React Flow node-type literal
 * (`"component"`, meaningless to any of the functions this service
 * calls), while the actual entity type (client/api/database/...) belongs
 * at `data.entityType`. `costEngine.ts`'s `estimateCost` specifically
 * reads `node.data.entityType` to look up pricing — get this wrong (as an
 * earlier draft of this adapter did, putting entity type at the top-level
 * `type` instead) and every node silently fails its pricing lookup,
 * producing a cost of $0 with no error — see decisions.md for how the
 * fixture-parity test caught this.
 */
export interface FakeArchitectureNode {
  id: string;
  type: "component";
  position: { x: number; y: number };
  data: { entityType: string; label: string; config: Record<string, unknown> };
}

/** For scoreScenario's `nodes: ArchitectureNode[]` parameter — the fakeNode trick, applied to every submitted node. */
export function toFakeArchitectureNodes(nodes: ClientEntity[]): FakeArchitectureNode[] {
  return nodes.map((n) => ({
    id: n.id,
    type: "component",
    position: n.position ?? { x: 0, y: 0 },
    data: { entityType: n.type, label: n.id, config: n.config ?? {} },
  }));
}

export function toConnectionConfigs(connections: ClientConnection[]) {
  return connections.map((c) => ({
    source: c.source,
    target: c.target,
    latencyMs: c.latencyMs,
    protocol: c.protocol,
  }));
}
