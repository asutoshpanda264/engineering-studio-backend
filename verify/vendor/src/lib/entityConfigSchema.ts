/**
 * Declarative config fields per entity type, for the Inspector panel.
 * Adding a new tunable knob to an entity is a new row here, not new JSX —
 * the Inspector renders whatever this table says an entity type has.
 *
 * Field keys match the config properties the entities themselves read
 * (see APIServerConfig / DatabaseConfig) — keep them in sync. The one
 * exception is Client's requestRate: the Client entity itself doesn't
 * generate its own traffic (see Client.ts), so workshopBridge reads this
 * field and feeds it into the scenario's traffic pattern instead.
 */

import type { EntityType } from "@/simulation/types";

/**
 * Three reference points for a numeric/percent field, in the field's own
 * native units (0-1 for percent, same as `default` — the Inspector's
 * popover multiplies by 100 for percent fields the same way it already
 * does for the editable value). Grounded in real-world figures where a
 * genuine industry number exists (a library's own documented default, a
 * public API's published rate limit, a widely-cited sizing formula) —
 * each `*Note` says what that figure is anchored to. `avg` is not always
 * this field's `default`: the field's own default is chosen for a legible
 * simulation at this app's toy scale, while `avg` is the closest
 * real-world figure that fits inside min..max, and the two sometimes
 * diverge on purpose (e.g. Kafka's Partition Count defaults to 3 for a
 * simple first run, but production guidance starts closer to 6–12).
 */
export interface FieldBenchmark {
  low: number;
  avg: number;
  high: number;
  lowNote: string;
  avgNote: string;
  highNote: string;
}

interface BaseFieldSchema {
  key: string;
  label: string;
  /** Abbreviated label for the compact summary shown directly on the node card. */
  shortLabel: string;
  description: string;
  /**
   * One or two sentences: what raising vs. lowering this actually changes.
   * The compact version shown in the Inspector's "i" popover — deliberately
   * short (feedback: the old inline reveal of `description` in full made
   * Configuration "too overwhelming" and "too long" for the sidebar).
   * `description` above stays the fuller, in-depth version — still used as
   * the failure-demo Inspector's native title tooltip.
   */
  impact: string;
}

export interface NumericFieldSchema extends BaseFieldSchema {
  /** "percent" fields are stored as 0-1 but edited as 0-100. */
  type: "number" | "percent";
  min: number;
  max: number;
  step: number;
  default: number;
  unit?: string;
  /** Omitted only where a low/avg/high framing doesn't apply (none currently — every numeric field has one). */
  benchmark?: FieldBenchmark;
}

export interface SelectFieldSchema extends BaseFieldSchema {
  type: "select";
  options: { value: string; label: string }[];
  default: string;
}

export type ConfigFieldSchema = NumericFieldSchema | SelectFieldSchema;

/**
 * Renders a raw config value the way a human should read it — a select's
 * option label instead of its stored value, a percent field's 0-1 storage
 * as "50%", a unit suffix where the field has one. Shared by anything that
 * needs to *display* a config value rather than edit it (e.g. the "Try It"
 * demos' remedy diffs) so that display logic doesn't get re-derived per
 * caller — undefined falls back to the field's own default, same as an
 * editable field would show.
 */
export function formatConfigFieldValue(field: ConfigFieldSchema, rawValue: unknown): string {
  if (field.type === "select") {
    const value = typeof rawValue === "string" ? rawValue : field.default;
    return field.options.find((option) => option.value === value)?.label ?? value;
  }
  const value = typeof rawValue === "number" ? rawValue : field.default;
  const display = field.type === "percent" ? value * 100 : value;
  // Round away float noise (e.g. 0.30000000000000004 * 100) without
  // truncating a deliberately fractional value like 2.5.
  const trimmed = Math.round(display * 100) / 100;
  const unit = field.type === "percent" ? "%" : field.unit ? ` ${field.unit}` : "";
  return `${trimmed}${unit}`;
}

/**
 * Formats one benchmark reference point the same way `formatConfigFieldValue`
 * formats a live value — same percent/unit conversion — so the popover's
 * Low/Avg/High chips read in the same units as the input right above them.
 */
export function formatBenchmarkValue(field: NumericFieldSchema, value: number): string {
  const display = field.type === "percent" ? value * 100 : value;
  const trimmed = Math.round(display * 100) / 100;
  const unit = field.type === "percent" ? "%" : field.unit ? ` ${field.unit}` : "";
  return `${trimmed}${unit}`;
}

export const ENTITY_CONFIG_SCHEMA: Partial<Record<EntityType, ConfigFieldSchema[]>> = {
  client: [
    {
      key: "requestRate",
      label: "Request Rate",
      shortLabel: "rate",
      type: "number",
      min: 0,
      max: 1000,
      step: 1,
      default: 20,
      unit: "req/s",
      description:
        "How many requests per second this client generates. Raise it to stress-test downstream capacity — every entity in the chain has to keep up or it starts queueing and rejecting. Lower it to see the same architecture behave well under light load.",
      impact:
        "Raise it to stress-test downstream capacity — everything in the chain has to keep up or start queueing and rejecting. Lower it to see the same architecture handle light load easily.",
      benchmark: {
        low: 2,
        avg: 20,
        high: 900,
        lowNote: "quiet, off-peak traffic",
        avgNote: "typical small production service",
        highNote: "flash-sale / thundering-herd surge (Black Friday, Big Billion Day) — real spikes commonly run 10–100x normal traffic",
      },
    },
    {
      key: "keyPoolSize",
      label: "Key Pool Size",
      shortLabel: "keys",
      type: "number",
      min: 1,
      max: 100_000,
      step: 1,
      default: 50,
      description:
        "How many distinct resources exist. Small pool = requests repeat a lot (a Cache can help). Large pool = requests are mostly unique (a Cache can't).",
      impact:
        "Raise it toward unique-per-request territory and a Cache stops helping. Lower it to concentrate requests on a small hot set a Cache can actually absorb.",
      benchmark: {
        low: 5,
        avg: 50,
        high: 5000,
        lowNote: "a small catalog — a cache can absorb almost all repeat lookups",
        avgNote: "a moderate catalog, this simulation's default scale",
        highNote: "a large catalog (e.g. a big product listing) — requests are mostly unique, so a cache barely helps",
      },
    },
    {
      key: "routePoolSize",
      label: "Route Pool Size",
      shortLabel: "routes",
      type: "number",
      min: 1,
      max: 8,
      step: 1,
      default: 3,
      description:
        "How many distinct named services this client's requests are spread across (uniformly, not skewed like Key Pool Size) — /orders, /users, /payments, and so on. Only matters if a Reverse Proxy is downstream: it's what a Reverse Proxy's routing rules match against. Irrelevant to every other entity.",
      impact:
        "Only matters with a Reverse Proxy downstream — more routes means more distinct rules its routing has to match against.",
      benchmark: {
        low: 1,
        avg: 3,
        high: 8,
        lowNote: "a single-service app — nothing to route between",
        avgNote: "a handful of services (e.g. /orders, /users, /payments)",
        highNote: "many distinct services sharing one entry point",
      },
    },
    {
      key: "missingKeyRate",
      label: "Missing Key Rate",
      shortLabel: "missing",
      type: "percent",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0,
      unit: "%",
      description:
        "Fraction of this client's requests that target a resource that will never exist — a typo'd id, a deleted record, an attacker probing for valid ids. These always land on the same small, fixed pool of permanently-missing keys, separate from the normal Key Pool. Only matters if a Cache is downstream: it's what a Cache's Negative Caching config protects against — cache penetration. 0 = off, the default: no phantom traffic.",
      impact:
        "Raise it to simulate cache-penetration traffic (probing for ids that don't exist) hitting a Cache's Negative Caching defense. 0 means no phantom traffic at all.",
      benchmark: {
        low: 0,
        avg: 0.05,
        high: 0.3,
        lowNote: "no phantom lookups — realistic well-behaved traffic",
        avgNote: "light probing / stale-link traffic typical of public APIs",
        highNote: "sustained attacker probing for valid ids — a cache-penetration attack",
      },
    },
    {
      key: "relationshipQueryRate",
      label: "Relationship Query Rate",
      shortLabel: "rel query",
      type: "percent",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0,
      unit: "%",
      description:
        "Fraction of this client's requests that need multi-hop relationship reasoning to answer correctly (\"which vendors does our highest-risk supplier also share with?\") rather than a single similarity-matched chunk. Only matters if a Retriever is downstream: chunk-similarity search (Pipeline, and to a lesser extent Agentic) structurally can't answer these well no matter how good the embeddings are — GraphRAG's whole reason for existing is winning specifically on this traffic. 0 = off, the default: no relationship-shaped traffic.",
      impact:
        "Raise it to simulate research/compliance-style traffic that genuinely needs graph traversal — this is what makes GraphRAG's accuracy advantage (and Pipeline's structural weakness on the same traffic) visible in a Retriever comparison.",
      benchmark: {
        low: 0,
        avg: 0.15,
        high: 0.5,
        lowNote: "simple lookup/FAQ-style traffic — no relationship reasoning needed",
        avgNote: "a typical mixed research/support workload",
        highNote: "compliance analysis or research-synthesis traffic — mostly multi-hop queries",
      },
    },
  ],
  api: [
    {
      key: "maxConcurrent",
      label: "Max Concurrent",
      shortLabel: "max",
      type: "number",
      min: 1,
      max: 50,
      step: 1,
      default: 10,
      description:
        "Requests this server can process at the same time. Raise it to admit more concurrent traffic before anything queues or gets rejected — the realistic ceiling is CPU/memory per instance, not a free lever. Lower it to see the same traffic start backing up and failing sooner.",
      impact:
        "Raise it to admit more concurrent requests before anything queues. The realistic ceiling is CPU/memory per instance, not a free lever.",
      benchmark: {
        low: 2,
        avg: 10,
        high: 40,
        lowNote: "a small single-core instance",
        avgNote: "a typical mid-sized instance or container",
        highNote: "a large, highly concurrent instance (many cores, async I/O)",
      },
    },
    {
      key: "maxQueueLength",
      label: "Max Queue Length",
      shortLabel: "queue",
      type: "number",
      min: 0,
      max: 200,
      step: 1,
      default: 50,
      description:
        "Requests allowed to wait once at capacity, before being rejected. Raise it to absorb short traffic bursts without dropping requests, at the cost of higher latency for whatever's waiting. Lower it (or set 0) to reject overflow immediately instead of making it wait.",
      impact:
        "Raise it to absorb bursts without rejecting requests, at the cost of higher latency for whatever's waiting.",
      benchmark: {
        low: 0,
        avg: 50,
        high: 150,
        lowNote: "fail-fast — reject overflow immediately, nothing waits",
        avgNote: "absorbs a short burst without dropping requests",
        highNote: "deep buffering — rides out large bursts at the cost of high tail latency",
      },
    },
    {
      key: "processingTimeMs",
      label: "Processing Time",
      shortLabel: "proc",
      type: "number",
      min: 1,
      max: 200,
      step: 1,
      default: 5,
      unit: "ms",
      description:
        "Time spent handling business logic per request. Raise it to simulate heavier per-request work — each server occupies its concurrency slots longer, so effective throughput drops even with Max Concurrent unchanged. Lower it to free up slots faster and raise effective throughput.",
      impact:
        "Raise it to model heavier per-request work — each request occupies a concurrency slot longer, so effective throughput drops even with Max Concurrent unchanged.",
      benchmark: {
        low: 1,
        avg: 5,
        high: 100,
        lowNote: "a trivial handler — cache read, simple validation",
        avgNote: "typical lightweight business logic",
        highNote: "heavy per-request work — complex computation or chained calls",
      },
    },
  ],
  database: [
    {
      key: "type",
      label: "Database Type",
      shortLabel: "type",
      type: "select",
      default: "sql",
      options: [
        { value: "sql", label: "SQL — Relational" },
        { value: "nosql", label: "NoSQL — Document / Key-Value" },
      ],
      description:
        "SQL (relational: Postgres, MySQL) enforces a fixed schema and supports joins and ACID transactions — strong consistency, but that query-planning and locking overhead caps how much concurrent write throughput a single instance handles, and joins make horizontal sharding hard. NoSQL (DynamoDB, MongoDB, Cassandra) trades that away for a flexible schema and data partitioned by key across many nodes — much higher concurrent write throughput and easier horizontal scaling, at the cost of joins and (usually) strong consistency. NoSQL isn't one thing, either: document stores (MongoDB), key-value stores (DynamoDB, Redis), column-family stores (Cassandra), and graph databases (Neo4j) each solve a different access pattern — this option collapses all four into one simulated profile, not four distinct shapes. Reach for SQL when correctness and relationships between records matter more than raw throughput (orders, payments, inventory); reach for NoSQL when the access pattern is simple lookups by key at high volume and slightly-stale reads are acceptable (event/analytics ingestion, session storage, catalogs). This changes simulated behavior here: NoSQL applies roughly 3x the effective connection ceiling and roughly half the query time on top of whatever Max Connections / Processing Time you set below, modeling partitioning and simpler key-based access — it does not simulate schemas, joins, or consistency guarantees, and it does not distinguish between NoSQL's four subtypes.",
      impact:
        "SQL trades throughput for consistency and joins; NoSQL trades that away for roughly 3x the connection ceiling and half the query time here. Most teams default to SQL for transactional data and NoSQL for high-volume key lookups.",
    },
    {
      key: "maxConnections",
      label: "Max Connections",
      shortLabel: "conn",
      type: "number",
      min: 1,
      max: 50,
      step: 1,
      default: 5,
      description:
        "Queries the connection pool can run at the same time. Raise it to let more queries execute concurrently before they queue — real databases cap this because each connection costs memory on the server, so it's not free to raise indefinitely. Lower it to see contention for the pool show up sooner.",
      impact:
        "Raise it to run more queries concurrently — real databases cap this because each connection reserves memory server-side, so it isn't free to raise indefinitely.",
      benchmark: {
        low: 2,
        avg: 10,
        high: 30,
        lowNote: "a small single instance (HikariCP's own cores×2+1 rule of thumb, for ~2 cores)",
        avgNote: "a typical single-instance pool size for a small-to-mid service",
        highNote: "many app instances sharing one database, approaching its own max_connections ceiling",
      },
    },
    {
      key: "maxQueueLength",
      label: "Max Queue Length",
      shortLabel: "queue",
      type: "number",
      min: 0,
      max: 500,
      step: 1,
      default: 100,
      description:
        "Queries allowed to wait once at capacity, before being rejected. Raise it to ride out a burst of queries without failing any of them, at the cost of every waiting query getting slower. Lower it (or set 0) to fail overflow queries immediately instead of queueing them.",
      impact:
        "Raise it to ride out a burst of queries without failing any, at the cost of every waiting query getting slower.",
      benchmark: {
        low: 0,
        avg: 100,
        high: 400,
        lowNote: "fail fast on overflow — no query ever waits",
        avgNote: "absorbs a normal burst of queries",
        highNote: "deep buffering under sustained overload — expect high wait times",
      },
    },
    {
      key: "processingTimeMs",
      label: "Processing Time",
      shortLabel: "query",
      type: "number",
      min: 1,
      max: 300,
      step: 1,
      default: 15,
      unit: "ms",
      description:
        "Time spent executing a single query. Raise it to model heavier queries (missing indexes, large scans, complex joins) — each occupies a connection longer, lowering effective throughput at a given Max Connections. Lower it to model a faster, well-indexed query.",
      impact:
        "Raise it to model heavier queries (missing indexes, large scans, complex joins) — each occupies a connection longer, lowering effective throughput.",
      benchmark: {
        low: 1,
        avg: 15,
        high: 150,
        lowNote: "a fast, well-indexed point lookup",
        avgNote: "a typical indexed query with a join or two",
        highNote: "a missing index, large table scan, or complex multi-join query",
      },
    },
    {
      key: "failureProbability",
      label: "Failure Probability",
      shortLabel: "fail",
      type: "percent",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0,
      unit: "%",
      description:
        "Chance a query fails independently of load — models flaky infrastructure, not overload. Raise it to see errors appear even when the database is nowhere near capacity, and to test whether a Circuit Breaker or retry logic upstream actually helps. 0 means failures only ever come from being over capacity.",
      impact:
        "Raise it to see errors appear even far under capacity, and to test whether a Circuit Breaker or retry logic upstream actually helps.",
      benchmark: {
        low: 0,
        avg: 0.02,
        high: 0.2,
        lowNote: "healthy, reliable infrastructure",
        avgNote: "occasional flaky infra — brief network blips, failovers",
        highNote: "a database having a genuinely bad day — degraded instance, ongoing incident",
      },
    },
  ],
  load_balancer: [
    {
      key: "algorithm",
      label: "Algorithm",
      shortLabel: "algo",
      type: "select",
      default: "round_robin",
      options: [
        { value: "round_robin", label: "Round Robin" },
        { value: "least_connections", label: "Least Connections" },
        { value: "weighted_round_robin", label: "Weighted Round Robin" },
        { value: "ip_hash", label: "IP Hash" },
        { value: "least_response_time", label: "Least Response Time" },
      ],
      description:
        "Round robin cycles through targets in order, regardless of load. Least connections sends each request to whichever target currently has the fewest in-flight requests — they behave identically when targets are equally fast, and diverge once one is slower or overloaded: round robin keeps sending it an equal share anyway, least connections routes around it. Weighted round robin cycles through targets like plain round robin, but proportional to each target's configured weight below (a weight-3 target gets 3x a weight-1 target's share) — it diverges from plain round robin by design, not by load, useful when targets have known, fixed capacity differences (a bigger instance type, for example) rather than load that varies at runtime. IP Hash routes by hashing a per-request identifier so the same identifier always lands on the same target — session affinity, at the cost of not rebalancing around slow targets at all; this simulation has no modeled client IP, so it hashes the request's resource key instead (the closest available stand-in — a documented substitution, not a literal IP). Least Response Time is least connections' generalization from request count to actual observed latency — it routes to whichever target has the lowest recent average response time, so it reacts to a target that's technically available but just slow, not only one that's saturated.",
      impact:
        "Round Robin and Least Connections behave identically until one target is slower — then Least Connections routes around it while Round Robin keeps feeding it an equal share. Most real load balancers default to a load-aware algorithm once backends aren't perfectly uniform.",
    },
  ],
  cache: [
    {
      key: "capacity",
      label: "Capacity",
      shortLabel: "cap",
      type: "number",
      min: 1,
      max: 500,
      step: 1,
      default: 20,
      unit: "keys",
      description:
        "How many distinct keys the cache can hold before it must evict one to make room. Raise it to hold more of the Client's key pool at once, improving hit rate (fewer evictions competing for the same slots) — real memory-backed caches size this against available RAM, so it isn't free to raise indefinitely. Lower it to evict more aggressively and see the hit rate drop.",
      impact:
        "Raise it to hold more of the working set at once and evict less often, improving hit rate — real memory-backed caches size this against available RAM.",
      benchmark: {
        low: 5,
        avg: 20,
        high: 300,
        lowNote: "a tiny cache — heavy eviction pressure",
        avgNote: "a modest cache relative to a typical key pool",
        highNote: "a large in-memory cache (e.g. a dedicated Redis instance) sized to hold most of the working set",
      },
    },
    {
      key: "evictionPolicy",
      label: "Eviction Policy",
      shortLabel: "evict",
      type: "select",
      default: "lru",
      options: [
        { value: "lru", label: "LRU — Least Recently Used" },
        { value: "lfu", label: "LFU — Least Frequently Used" },
        { value: "fifo", label: "FIFO — First In, First Out" },
        { value: "mru", label: "MRU — Most Recently Used" },
      ],
      description:
        "Which entry to remove when a new key arrives at capacity. LRU (the common default) evicts whatever hasn't been touched in the longest time — good for most traffic shapes. LFU evicts whatever's been requested least often — better when a small set of keys is disproportionately hot. FIFO ignores access pattern entirely and evicts oldest-inserted first — simplest, worst hit rate under skewed traffic. MRU evicts the most recently used entry, which only makes sense for unusual cyclic-scan access patterns and generally performs worst here.",
      impact:
        "LRU is the default almost everywhere general-purpose caching is used; LFU only pays off when a small set of keys is disproportionately hot.",
    },
    {
      key: "ttlMs",
      label: "TTL",
      shortLabel: "ttl",
      type: "number",
      min: 0,
      max: 60_000,
      step: 100,
      default: 0,
      unit: "ms",
      description:
        "How long an entry stays valid after being stored. 0 = never expires on its own (only eviction removes it). Raise it to keep entries valid longer and improve hit rate, at the cost of staler data being served. Lower it to force fresher re-fetches more often, trading hit rate for freshness.",
      impact:
        "Raise it to keep entries valid longer and improve hit rate, at the cost of staler data. 0 means entries never expire on their own.",
      benchmark: {
        low: 1000,
        avg: 15_000,
        high: 60_000,
        lowNote: "near-real-time freshness — a live leaderboard or stock ticker",
        avgNote: "a typical short-lived cache entry (session data, hot API responses)",
        highNote: "the longest allowed here — semi-static content like config or reference data",
      },
    },
    {
      key: "stampedeMode",
      label: "Stampede Protection",
      shortLabel: "stampede",
      type: "select",
      default: "naive",
      options: [
        { value: "naive", label: "Naive — every concurrent miss re-fetches" },
        { value: "coalesced", label: "Coalesced — one fetch, others wait" },
      ],
      description:
        "What happens when several requests for the same key miss while a fetch for it is already in flight — a cache stampede, typically triggered by a hot key's TTL expiring under load. Naive: each one independently re-fetches from downstream, multiplying load right when it's least wanted. Coalesced: only the first miss fetches; the rest wait on it and share whatever it returns (request coalescing / single-flight, the standard production fix) — at the cost of holding their own slot in this cache's concurrency/queue the whole time they wait.",
      impact:
        "Coalesced (single-flight) is the standard production fix for a hot key's TTL expiring under load — most high-traffic caches implement some form of it.",
    },
    {
      key: "negativeCaching",
      label: "Negative Caching",
      shortLabel: "negcache",
      type: "select",
      default: "off",
      options: [
        { value: "off", label: "Off — every miss for a missing key re-fetches" },
        { value: "on", label: "On — cache \"not found\" too" },
      ],
      description:
        "What happens on a miss for a key that turns out not to exist downstream (see the Client's Missing Key Rate) — cache penetration. Off: every request for that permanently-missing key makes its own full downstream round trip, forever — exactly what an attacker probing for valid ids exploits. On: the first \"not found\" result is cached too, for Negative Cache TTL below, so repeat lookups for the same missing key are answered straight from this cache instead of hammering downstream again.",
      impact:
        "Negative caching is the standard defense against cache-penetration attacks (repeated lookups for ids that don't exist) — most production caches enable it once that pattern shows up.",
    },
    {
      key: "negativeCacheTtlMs",
      label: "Negative Cache TTL",
      shortLabel: "negttl",
      type: "number",
      min: 0,
      max: 60_000,
      step: 100,
      default: 2000,
      unit: "ms",
      description:
        "Negative Caching only — how long a cached \"not found\" stays valid before the next lookup re-checks downstream. Real systems usually keep this shorter than a normal positive TTL: too long risks masking a resource created later; too short reopens the door to penetration between expiries. 0 = never expires once cached.",
      impact:
        "Real systems keep this shorter than a normal positive TTL — long enough to blunt penetration, short enough that a newly created resource doesn't stay invisible for long.",
      benchmark: {
        low: 500,
        avg: 2000,
        high: 30_000,
        lowNote: "very short — minimizes the risk of masking a resource created moments later",
        avgNote: "a typical negative-cache TTL — shorter than a normal positive TTL",
        highNote: "a long negative TTL — strong penetration protection, more risk of masking a new record",
      },
    },
    {
      key: "ttlJitterPercent",
      label: "TTL Jitter",
      shortLabel: "jitter",
      type: "percent",
      min: 0,
      max: 0.5,
      step: 0.01,
      default: 0,
      unit: "%",
      description:
        "Randomizes each entry's own TTL by up to ± this fraction of the configured TTL above, so a batch of entries cached around the same time (a cold start, a deploy) don't all expire in the same instant — a cache avalanche. 0 = off, the default: every entry shares the exact same TTL, so a wave of near-simultaneous first-time cache fills expires as one synchronized wave of downstream re-fetches later. Has no effect when TTL is 0 (never-expiring entries have nothing to stagger).",
      impact:
        "Raise it to spread a batch of same-time expirations across a wider window, avoiding a synchronized cache-avalanche re-fetch storm.",
      benchmark: {
        low: 0,
        avg: 0.1,
        high: 0.3,
        lowNote: "no jitter — a batch cached together expires as one synchronized wave",
        avgNote: "light staggering — a common starting point for spreading expirations",
        highNote: "aggressive staggering — strongly spreads out a cold-start or post-deploy cache-fill wave",
      },
    },
    {
      key: "cachingMode",
      label: "Caching Mode",
      shortLabel: "mode",
      type: "select",
      default: "exact",
      options: [
        { value: "exact", label: "Exact — key match only" },
        { value: "semantic", label: "Semantic — similarity match (docs/Agentic_AI.md §2.9)" },
      ],
      description:
        "Exact answers a hit only when the identical key was already cached — every use of Cache before this field existed. Semantic — wired upstream of an llm_call, this is what docs/Agentic_AI.md means by semantic caching — adds an extra chance of hitting even on a key that was never seen before, standing in for 'a semantically-similar-enough query was already answered.' It's additive, not a replacement: an exact repeat of the same key still hits for free either way.",
      impact:
        "Semantic mode raises the effective hit rate beyond what the traffic's own key repetition alone would produce — useful specifically in front of an llm_call, where the payoff is skipping the model call entirely, not just a faster lookup.",
    },
    {
      key: "semanticHitRate",
      label: "Semantic Hit Rate",
      shortLabel: "sem hit",
      type: "percent",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.7,
      unit: "%",
      description:
        "Chance an otherwise-missed request 'hits' via similarity to something already cached, once the store is completely full — scales down toward 0 as the store empties out (nothing cached yet means nothing to be similar to). Semantic mode only. Production semantic caches report 20-45% hit rates in practice; this dial is the ceiling once the cache has actually warmed up, not the observed rate itself.",
      impact:
        "Only affects Semantic mode. Raise it to model a better-tuned similarity threshold or a more repetitive query distribution; lower it toward 0 to see Semantic mode converge back to Exact's behavior.",
      benchmark: {
        low: 0.2,
        avg: 0.5,
        high: 0.9,
        lowNote: "a conservative similarity threshold — few false hits, closer to Exact mode",
        avgNote: "a typical production semantic cache once warmed up",
        highNote: "a loose similarity threshold — high hit rate, more risk of answering a genuinely different query with a stale cached response",
      },
    },
  ],
  cdn: [
    {
      key: "edgeCount",
      label: "Edge Count",
      shortLabel: "edges",
      type: "number",
      min: 1,
      max: 20,
      step: 1,
      default: 5,
      description:
        "How many geographically distributed edges the CDN operates. Raise it for better geographic coverage (more users land near an edge, lower latency on average) — but the same traffic now splits across more independent, separately-warmed caches, so each edge sees fewer requests and its own hit rate drops. Lower it to concentrate traffic on fewer edges — higher per-edge hit rate, less geographic spread.",
      impact:
        "Raise it for better geographic coverage — but the same traffic now splits across more independently-warmed caches, so each edge's own hit rate drops.",
      benchmark: {
        low: 1,
        avg: 5,
        high: 20,
        lowNote: "a single PoP — effectively no geographic distribution (a lean network like early Fastly)",
        avgNote: "a modest regional edge network",
        highNote: "broad global footprint — real large providers (CloudFront, Akamai) run into the hundreds or thousands; this simulation caps far lower",
      },
    },
    {
      key: "minEdgeLatencyMs",
      label: "Min Edge Latency",
      shortLabel: "near",
      type: "number",
      min: 0,
      max: 500,
      step: 1,
      default: 1,
      unit: "ms",
      description:
        "One-way latency to the nearest edge — the best case, for a user who happens to land close to one. Raise it to model a sparser edge network with longer minimum reach; lower it to model edges placed very close to users.",
      impact:
        "Raise it to model a sparser edge network with longer minimum reach; lower it to model edges placed very close to users.",
      benchmark: {
        low: 0,
        avg: 1,
        high: 50,
        lowNote: "user co-located with an edge, same metro area",
        avgNote: "user near a well-placed edge",
        highNote: "a sparse edge network — even the nearest edge is a real hop away",
      },
    },
    {
      key: "maxEdgeLatencyMs",
      label: "Max Edge Latency",
      shortLabel: "far",
      type: "number",
      min: 0,
      max: 500,
      step: 1,
      default: 6,
      unit: "ms",
      description:
        "One-way latency to the farthest edge — the worst case, for a user furthest from any edge. Raise it to widen the gap between best- and worst-served users; lower it (closer to Min Edge Latency) to make which edge a user hits matter less.",
      impact:
        "Raise it to widen the gap between best- and worst-served users; lower it toward Min Edge Latency to make which edge a user hits matter less.",
      benchmark: {
        low: 1,
        avg: 6,
        high: 200,
        lowNote: "edges packed tightly — worst case is barely worse than best case",
        avgNote: "a typical spread between nearest and farthest edge",
        highNote: "a sparse network — a user far from any edge pays a real latency penalty",
      },
    },
    {
      key: "capacity",
      label: "Capacity (per edge)",
      shortLabel: "cap",
      type: "number",
      min: 1,
      max: 500,
      step: 1,
      default: 20,
      unit: "keys",
      description:
        "How many distinct keys each edge can hold before it must evict one. Raise it so each edge holds more of the working set and evicts less often, improving that edge's hit rate. Lower it to see edges thrash (evict-then-refetch) sooner under the same traffic.",
      impact:
        "Raise it so each edge holds more of the working set and evicts less often, improving that edge's own hit rate.",
      benchmark: {
        low: 5,
        avg: 20,
        high: 300,
        lowNote: "a small edge cache — frequent eviction",
        avgNote: "a modest per-edge cache",
        highNote: "a large per-edge cache holding most of that edge's working set",
      },
    },
    {
      key: "evictionPolicy",
      label: "Eviction Policy",
      shortLabel: "evict",
      type: "select",
      default: "lru",
      options: [
        { value: "lru", label: "LRU — Least Recently Used" },
        { value: "lfu", label: "LFU — Least Frequently Used" },
        { value: "fifo", label: "FIFO — First In, First Out" },
        { value: "mru", label: "MRU — Most Recently Used" },
      ],
      description:
        "Which entry an edge removes when a new key arrives at its capacity. Same tradeoff as Cache's eviction policy, applied independently at every edge: LRU suits most traffic, LFU favors a small hot set, FIFO is simplest but least accurate, MRU is a special case that usually hurts hit rate here.",
      impact:
        "Same tradeoff as a Cache's eviction policy, applied independently at every edge — LRU suits most traffic.",
    },
    {
      key: "ttlMs",
      label: "TTL",
      shortLabel: "ttl",
      type: "number",
      min: 0,
      max: 60_000,
      step: 100,
      default: 0,
      unit: "ms",
      description:
        "How long an entry stays valid at an edge. 0 = never expires on its own. Raise it to keep edge content valid longer and improve hit rate, at the cost of staler content being served from edges. Lower it to force more frequent re-fetches from origin, trading hit rate for freshness.",
      impact:
        "Raise it to keep edge content valid longer and improve hit rate, at the cost of staler content served from edges.",
      benchmark: {
        low: 1000,
        avg: 15_000,
        high: 60_000,
        lowNote: "near-real-time edge freshness",
        avgNote: "a typical short-lived edge cache entry",
        highNote: "the longest allowed here — largely static assets like images or JS bundles",
      },
    },
  ],
  message_queue: [
    {
      key: "deliveryMode",
      label: "Delivery Mode",
      shortLabel: "mode",
      type: "select",
      default: "queue",
      options: [
        { value: "queue", label: "Queue — point-to-point" },
        { value: "topic", label: "Topic — fan-out / pub-sub" },
      ],
      description:
        "Queue (point-to-point): a shared pool of consumers competes for each message, so exactly one consumer gets it — a classic task queue, connect one downstream target. Topic (fan-out/pub-sub): every downstream connection is treated as an independent subscriber with its own consumer pool, and gets its own copy of every message — connect several downstream targets to see fan-out. A slow subscriber under Topic only ever falls behind on its own copy; it never blocks the publish or any other subscriber, since there's no shared backlog to overflow. That also means fan-out multiplies dispatch load by subscriber count for the same producer rate — a topic backs up faster than a queue unless Consumer Count / Max Queue Length are sized for that.",
      impact:
        "Queue is the default for task distribution — one consumer per message. Topic is for fan-out, where several independent subscribers each need their own copy.",
    },
    {
      key: "consumerCount",
      label: "Consumer Count",
      shortLabel: "consumers",
      type: "number",
      min: 1,
      max: 50,
      step: 1,
      default: 3,
      description:
        "Consumers pulling messages off the backlog at the same time — per subscriber, under Topic mode. Raise it to drain the backlog faster and keep messages from piling up under sustained load. Lower it to see the backlog grow and messages wait longer before being picked up.",
      impact:
        "Raise it to drain the backlog faster under sustained load; lower it to see the backlog grow and messages wait longer.",
      benchmark: {
        low: 1,
        avg: 3,
        high: 30,
        lowNote: "a single worker — simplest, no parallel drain",
        avgNote: "a small worker pool, a typical starting point",
        highNote: "a large autoscaled worker fleet draining a big backlog",
      },
    },
    {
      key: "maxQueueLength",
      label: "Max Queue Length",
      shortLabel: "backlog",
      type: "number",
      min: 0,
      max: 5_000,
      step: 10,
      default: 500,
      description:
        "Messages the backlog can buffer once every consumer is busy, before rejecting new ones — per subscriber, under Topic mode. Raise it to absorb a bigger burst of producer traffic without dropping messages, at the cost of longer wait times for whatever's backlogged. Lower it to reject overflow sooner instead of letting the backlog grow unbounded.",
      impact:
        "Raise it to absorb a bigger burst of producer traffic without dropping messages, at the cost of longer wait times for whatever's backlogged.",
      benchmark: {
        low: 50,
        avg: 500,
        high: 3000,
        lowNote: "a small buffer — roughly a 0.1s-processing worker's 10-second backlog budget",
        avgNote: "a typical backlog buffer",
        highNote: "deep buffering for a bursty producer, common with SQS-style queues",
      },
    },
    {
      key: "dispatchTimeMs",
      label: "Dispatch Time",
      shortLabel: "dispatch",
      type: "number",
      min: 1,
      max: 500,
      step: 1,
      default: 10,
      unit: "ms",
      description:
        "Time a consumer takes to pick up and hand off one message. Raise it to model slower consumers — each occupies a consumer slot longer, lowering effective drain rate even with Consumer Count unchanged. Lower it to model faster consumers and a quicker-draining backlog.",
      impact:
        "Raise it to model slower consumers — each occupies a consumer slot longer, lowering effective drain rate even with Consumer Count unchanged.",
      benchmark: {
        low: 1,
        avg: 10,
        high: 200,
        lowNote: "a trivial handoff — just enqueue elsewhere",
        avgNote: "typical lightweight message handling",
        highNote: "heavy per-message work — a slow downstream call per message",
      },
    },
  ],
  kafka: [
    {
      key: "partitionCount",
      label: "Partition Count",
      shortLabel: "partitions",
      type: "number",
      min: 1,
      max: 12,
      step: 1,
      default: 3,
      description:
        "How many partitions the topic is split into. A message's partition is a deterministic hash of its key, so the same key always lands in the same partition — strict ordering within a partition, no ordering promise across partitions. Also caps how many consumers any one consumer group can usefully run at once (see Consumers per Group) — raising this is how you buy more real parallelism, not just adding more consumers.",
      impact:
        "Raise it to buy more real parallelism and finer ordering scope — but partitions can't be decreased later, so real deployments plan ahead for growth.",
      benchmark: {
        low: 1,
        avg: 6,
        high: 12,
        lowNote: "no parallelism — a consumer group can usefully run only one consumer",
        avgNote: "a common production starting point (start around 6–12 partitions, then scale with throughput)",
        highNote: "this simulation's ceiling — real clusters scale into the hundreds or thousands across all topics, not just one",
      },
    },
    {
      key: "consumerCountPerGroup",
      label: "Consumers per Group",
      shortLabel: "consumers",
      type: "number",
      min: 1,
      max: 20,
      step: 1,
      default: 3,
      description:
        "Consumers each connected consumer group runs. A group's useful parallelism is capped at min(this, Partition Count) — a consumer beyond the partition count has no partition left to read and sits idle. Raise Partition Count, not this, once you've hit that ceiling.",
      impact:
        "A group's useful parallelism is capped at min(this, Partition Count) — raise Partition Count first if you've hit that ceiling, not this.",
      benchmark: {
        low: 1,
        avg: 3,
        high: 12,
        lowNote: "a single consumer — no parallelism within the group",
        avgNote: "a typical small consumer group, matched to a modest partition count",
        highNote: "matched 1:1 with a fully-partitioned topic — the ceiling of useful parallelism",
      },
    },
    {
      key: "maxQueueLength",
      label: "Max Queue Length",
      shortLabel: "backlog",
      type: "number",
      min: 0,
      max: 5_000,
      step: 10,
      default: 500,
      description:
        "Messages a consumer group's own backlog can buffer once every one of its consumers is busy, before that group starts falling behind (a bounded stand-in for consumer lag against a retention window). Independent per group — one group falling behind never affects another's backlog.",
      impact:
        "Raise it to tolerate more consumer lag before a group counts as falling behind. Independent per group.",
      benchmark: {
        low: 50,
        avg: 500,
        high: 3000,
        lowNote: "a small lag budget before a group counts as falling behind",
        avgNote: "a typical lag buffer per consumer group",
        highNote: "a generous lag allowance for a bursty producer",
      },
    },
    {
      key: "dispatchTimeMs",
      label: "Dispatch Time",
      shortLabel: "dispatch",
      type: "number",
      min: 1,
      max: 500,
      step: 1,
      default: 10,
      unit: "ms",
      description:
        "Time a consumer takes to pick up and hand off one message, per consumer group. Raise it to model slower consumers — lowers a group's effective drain rate even with its consumer count unchanged.",
      impact:
        "Raise it to model slower per-group consumers — lowers that group's effective drain rate even with its consumer count unchanged.",
      benchmark: {
        low: 1,
        avg: 10,
        high: 200,
        lowNote: "a trivial per-message handoff",
        avgNote: "typical lightweight message handling",
        highNote: "heavy per-message work, slowing this group's drain rate",
      },
    },
  ],
  rate_limiter: [
    {
      key: "algorithm",
      label: "Algorithm",
      shortLabel: "algo",
      type: "select",
      default: "token_bucket",
      options: [
        { value: "token_bucket", label: "Token Bucket" },
        { value: "sliding_window", label: "Sliding Window" },
      ],
      description:
        "Token bucket accumulates idle capacity and lets a burst through in one go, up to Burst Capacity, before throttling to the steady rate. Sliding window is a hard, steady ceiling with no burst allowance — they admit the same under smooth traffic and diverge once traffic bursts: token bucket forgives the spike, sliding window rejects the overflow immediately.",
      impact:
        "Token bucket is the more common real-world choice (most API gateways) because it tolerates natural bursts; sliding window suits a hard, steady ceiling more than burst tolerance.",
    },
    {
      key: "requestsPerSecond",
      label: "Requests / Second",
      shortLabel: "rate",
      type: "number",
      min: 1,
      max: 1000,
      step: 1,
      default: 50,
      unit: "req/s",
      description:
        "The steady-state rate this limiter admits requests at. Raise it to let more traffic through to whatever's downstream (weaker protection, fewer rejections here). Lower it to protect downstream more aggressively, at the cost of rejecting more legitimate traffic once the ceiling is hit.",
      impact:
        "Raise it to let more traffic through downstream (weaker protection, fewer rejections). Lower it to protect downstream more aggressively, at the cost of rejecting more legitimate traffic.",
      benchmark: {
        low: 5,
        avg: 100,
        high: 600,
        lowNote: "a tightly protective limit — close to Stripe's sandbox-mode limit (25 req/s) or a single-user quota",
        avgNote: "in the range of Stripe's live-mode limit (100 req/s) — a reasonable steady-state ceiling for a protected API",
        highNote: "a high-traffic public endpoint's aggregate limit, well above any single client's normal rate",
      },
    },
    {
      key: "burstCapacity",
      label: "Burst Capacity",
      shortLabel: "burst",
      type: "number",
      min: 1,
      max: 1000,
      step: 1,
      default: 100,
      unit: "tokens",
      description:
        "Token Bucket only — how many requests can burst through at once once idle capacity has accumulated. Raise it to tolerate bigger spikes without rejecting them. Lower it to clamp bursts down closer to the steady Requests/Second rate. Has no effect under Sliding Window.",
      impact:
        "Token Bucket only — raise it to tolerate bigger spikes without rejecting them. Has no effect under Sliding Window.",
      benchmark: {
        low: 10,
        avg: 100,
        high: 500,
        lowNote: "minimal burst tolerance — close to the steady rate",
        avgNote: "a typical burst allowance, roughly 2x the steady rate",
        highNote: "generous burst tolerance for spiky legitimate traffic",
      },
    },
  ],
  circuit_breaker: [
    {
      key: "failureThreshold",
      label: "Failure Threshold",
      shortLabel: "threshold",
      type: "number",
      min: 1,
      max: 50,
      step: 1,
      default: 5,
      unit: "failures",
      description:
        "Consecutive failures from the wrapped target before this breaker trips open. Raise it to tolerate more transient errors before cutting the target off (slower to protect, less prone to tripping on noise). Lower it to trip sooner (more protective, but more prone to a false trip on a brief blip).",
      impact:
        "Raise it to tolerate more transient errors before cutting the target off. Lower it to trip sooner, at the risk of a false trip on a brief blip.",
      benchmark: {
        low: 2,
        avg: 5,
        high: 20,
        lowNote: "trips almost immediately — very protective, prone to false trips on noise",
        avgNote: "a common conservative starting point for consecutive-failure trips",
        highNote: "close to Resilience4j's own typical sliding-window size (~20 calls) evaluated against a failure-rate threshold — far more tolerant of noise",
      },
    },
    {
      key: "tripDurationMs",
      label: "Trip Duration",
      shortLabel: "trip",
      type: "number",
      min: 100,
      max: 60_000,
      step: 100,
      default: 5000,
      unit: "ms",
      description:
        "How long the breaker stays open, failing fast, before letting a single probe request through to check if the target has recovered. Raise it to give a struggling target more uninterrupted time to recover, at the cost of a longer outage for callers. Lower it to retry recovery sooner, at the risk of probing a target that hasn't actually recovered yet.",
      impact:
        "Raise it to give a struggling target more uninterrupted recovery time, at the cost of a longer outage for callers. Lower it to retry sooner, at the risk of probing too early.",
      benchmark: {
        low: 1000,
        avg: 10_000,
        high: 60_000,
        lowNote: "an aggressive, fast retry",
        avgNote: "a common starting point cited in circuit-breaker guides (Resilience4j)",
        highNote: "Resilience4j's own library default — gives a struggling target a full minute to recover",
      },
    },
    {
      key: "halfOpenMaxProbes",
      label: "Half-Open Probes",
      shortLabel: "probes",
      type: "number",
      min: 1,
      max: 10,
      step: 1,
      default: 1,
      unit: "probes",
      description:
        "Requests allowed through concurrently while checking if the target has recovered. One probe failing reopens the breaker immediately. Raise it to confirm recovery faster (more signal, sooner) but risk overwhelming a target that's only barely back. Lower it toward 1 for the safest, slowest recovery check.",
      impact:
        "Raise it to confirm recovery faster with more signal at once, but risk overwhelming a target that's only barely back. Lower it toward 1 for the safest check.",
      benchmark: {
        low: 1,
        avg: 3,
        high: 8,
        lowNote: "the safest choice — a single probe must succeed before fully reopening",
        avgNote: "Resilience4j's typical starting recommendation for permitted calls in half-open",
        highNote: "confirms recovery fast with many probes at once — risks overwhelming a target that's only barely back",
      },
    },
  ],
  replica_pool: [
    {
      key: "writeRatio",
      label: "Write Ratio",
      shortLabel: "writes",
      type: "percent",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.1,
      unit: "%",
      description:
        "Fraction of requests treated as writes, routed to the leader (the first connection drawn from this pool). The rest are reads, spread round-robin across the remaining connections — the read replicas. Raise it to send more load to the single leader, which doesn't scale horizontally the way replicas do — that's the realistic bottleneck this models. Lower it to spread more load across replicas, which is where this pattern actually helps.",
      impact:
        "Raise it to send more load to the single leader, which doesn't scale horizontally the way replicas do — that's the realistic bottleneck this models.",
      benchmark: {
        low: 0.02,
        avg: 0.1,
        high: 0.4,
        lowNote: "a heavily read-dominated system (e.g. a product catalog: reads outnumber writes 50:1+)",
        avgNote: "a common read-heavy production ratio (~90% reads / 10% writes)",
        highNote: "a write-heavy workload (e.g. logging/analytics ingestion) — approaching the point where a single-leader setup becomes the real bottleneck",
      },
    },
  ],
  llm_call: [
    {
      key: "tier",
      label: "Model Tier",
      shortLabel: "tier",
      type: "select",
      default: "llm",
      options: [
        { value: "slm", label: "SLM — Small Language Model" },
        { value: "llm", label: "LLM — Large Language Model" },
      ],
      description:
        "SLM (roughly 0.5B-14B parameters) is a different design philosophy from a 'worse LLM' — data quality and architectural efficiency over raw parameter count, purpose-built to run on consumer hardware, mobile NPUs, and edge SoCs. The 2026 rule of thumb: an SLM delivers roughly 90% of an LLM's functionality at roughly 10% of the cost. Here it applies a lower latency multiplier and cheaper $/token rate (see the cost readout), but also a higher hallucination-rate multiplier — cheaper and faster is a real trade-off against reliability, not a free win.",
      impact:
        "SLM is dramatically faster and cheaper but measurably less reliable here; LLM is the slow, expensive, more-reliable baseline every other tier/quantization option trades against.",
    },
    {
      key: "quantization",
      label: "Quantization",
      shortLabel: "quant",
      type: "select",
      default: "none",
      options: [
        { value: "none", label: "None — BF16" },
        { value: "fp8", label: "FP8" },
        { value: "int8", label: "INT8" },
        { value: "int4", label: "INT4" },
      ],
      description:
        "Compresses model weights to lower precision — a genuine three-way trade-off, not a single 'fast mode' toggle. FP8/INT8 is production-ready today: roughly 4x memory reduction with minimal accuracy loss, the recommended first thing to reach for. INT4 pushes further (~8x memory reduction) and is 'acceptable for most use cases' but starts to bite — real measured accuracy drops in edge deployments range from -0.6% to -6.2% depending on model and technique. Each step down here lowers latency and cost further while raising this node's effective hallucination rate — the accuracy cost is something you measure by running it, not something asserted in a lesson.",
      impact:
        "Each step down (None → FP8 → INT8 → INT4) trades latency and cost for a higher effective hallucination rate — there's no strictly-dominant choice, only a trade-off surface.",
    },
    {
      key: "deploymentTarget",
      label: "Deployment Target",
      shortLabel: "deploy",
      type: "select",
      default: "cloud",
      options: [
        { value: "cloud", label: "Cloud" },
        { value: "edge", label: "Edge — on-device" },
      ],
      description:
        "Cloud pays a network round-trip on every call (roughly 200-500ms in real deployments) but has no capability ceiling. Edge removes that round trip entirely — on-device inference lands sub-20ms token generation in real deployments — but only holds a genuinely edge-sized model (the SLM tier's 'Goldilocks zone'). Pairing Edge with the LLM tier isn't blocked outright here; instead it's simulated honestly: it applies a heavy latency penalty (an oversized model straining constrained hardware), so you discover why that combination is a bad idea by running it, not by being told. Edge also has no per-token API bill in the cost readout — you already own the hardware.",
      impact:
        "Edge removes network round-trip latency and per-token API cost entirely, but only genuinely pays off with the SLM tier — Edge + LLM is simulated as a real latency penalty, not disabled outright.",
    },
    {
      key: "maxConcurrent",
      label: "Max Concurrent",
      shortLabel: "max",
      type: "number",
      min: 1,
      max: 200,
      step: 1,
      default: 20,
      description:
        "Calls this node can be actively generating at once. Raise it to admit more concurrent calls before anything queues — real inference serving buys this via continuous batching and PagedAttention, not an unlimited lever. Lower it to see the same traffic start backing up and failing sooner, the same admit-queue-reject shape every bounded-capacity entity in this simulator uses.",
      impact:
        "Raise it to admit more concurrent calls before anything queues — real serving stacks buy this via continuous batching, not an unlimited lever.",
      benchmark: {
        low: 2,
        avg: 20,
        high: 128,
        lowNote: "a small, lightly-provisioned deployment",
        avgNote: "a typical mid-sized served endpoint",
        highNote: "close to the 128+ concurrent requests real H100 serving benchmarks report combining continuous batching, PagedAttention, and speculative decoding",
      },
    },
    {
      key: "maxQueueLength",
      label: "Max Queue Length",
      shortLabel: "queue",
      type: "number",
      min: 0,
      max: 300,
      step: 1,
      default: 100,
      description:
        "Calls allowed to wait once Max Concurrent is reached, before being rejected. Raise it to absorb a burst of requests without dropping any, at the cost of every waiting call getting slower. Lower it (or set 0) to reject overflow immediately instead of making callers wait.",
      impact:
        "Raise it to absorb bursts without rejecting calls, at the cost of higher latency for whatever's waiting.",
      benchmark: {
        low: 0,
        avg: 100,
        high: 250,
        lowNote: "fail-fast — reject overflow immediately, nothing waits",
        avgNote: "absorbs a normal burst without dropping calls",
        highNote: "deep buffering — rides out large bursts at the cost of high tail latency",
      },
    },
    {
      key: "processingTimeMs",
      label: "Generation Time",
      shortLabel: "gen",
      type: "number",
      min: 10,
      max: 5000,
      step: 10,
      default: 400,
      unit: "ms",
      description:
        "Base model 'thinking'/generation time, before the Model Tier, Quantization, and Deployment Target multipliers above are applied. Raise it to simulate a harder reasoning task (a longer chain of thought, a bigger context to attend over) — output tokens cost 3-8x what input tokens cost in real inference pricing, so a call that reasons verbosely pays a structurally different price than one that reads a lot of context and answers briefly. Lower it to simulate a short, simple call.",
      impact:
        "Raise it to model a harder reasoning task with a longer generation — every downstream multiplier (tier, quantization, deployment) scales this base number, not a flat total.",
      benchmark: {
        low: 50,
        avg: 400,
        high: 2000,
        lowNote: "a short, simple completion — classification, a one-line answer",
        avgNote: "a typical reasoning call with a moderate chain of thought",
        highNote: "a long, verbose chain-of-thought before a final answer",
      },
    },
    {
      key: "hallucinationRate",
      label: "Hallucination Rate",
      shortLabel: "halluc",
      type: "percent",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.03,
      unit: "%",
      description:
        "Chance this call's answer is confidently wrong — modeled here as an explicit failure so it's observable in metrics and the trace, even though a real hallucination usually succeeds at the infrastructure level while being simply wrong (agent failures often look like success in a trace, not an error). The effective rate is multiplied by whatever Model Tier and Quantization are configured above — a cheaper, more compressed model hallucinates more, which is the real accuracy cost those dials trade against speed and cost.",
      impact:
        "Raise it to see how often this call is silently wrong even when nothing else is misconfigured. Model Tier and Quantization multiply this rate further — SLM and heavier quantization make it worse.",
      benchmark: {
        low: 0,
        avg: 0.03,
        high: 0.15,
        lowNote: "a narrow, well-grounded task with little room to guess",
        avgNote: "a typical open-ended reasoning task",
        highNote: "a genuinely hard, ambiguous, or under-specified task — hallucination risk climbs fast here",
      },
    },
    {
      key: "schemaFailureRate",
      label: "Schema Failure Rate",
      shortLabel: "schema",
      type: "percent",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.02,
      unit: "%",
      description:
        "Chance this call's structured output doesn't match the shape the caller expected — wrong type, missing required field. One of the two most common documented agent failure modes: estimates put schema violations and hallucinated tool invocations together at 3-15% of production tool calls. Checked before Hallucination Rate on every call — a structurally malformed output never gets far enough to be evaluated for correctness.",
      impact:
        "Raise it to simulate a less disciplined structured-output setup. Pre-dispatch schema validation upstream is the real-world mitigation — this dial is what that validation is meant to catch.",
      benchmark: {
        low: 0,
        avg: 0.02,
        high: 0.15,
        lowNote: "strict structured-output enforcement, well-tested tool schemas",
        avgNote: "a typical, reasonably disciplined setup",
        highNote: "loose or under-specified schemas, complex nested arguments",
      },
    },
    {
      key: "promptInjectionRate",
      label: "Prompt Injection Rate",
      shortLabel: "inject",
      type: "percent",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.01,
      unit: "%",
      description:
        "Chance a successful call's output is actually hijacked by attacker-controlled instructions — docs/Agentic_AI.md §1.7's failure mode #9, direct prompt injection. Unlike Hallucination Rate, this isn't modeled as a failure: the request completes looking perfectly normal, `agent failures often look like success in a trace` made literal. Only a Guardrail Validator wired downstream (its Compromise Catch Rate) has any chance of catching it before it reaches the client.",
      impact:
        "Raise it to see how often a clean-looking success is actually compromised. With no Guardrail Validator downstream, nothing catches it — the failure is invisible in every metric except the trace.",
      benchmark: {
        low: 0,
        avg: 0.01,
        high: 0.1,
        lowNote: "trusted, sanitized input only — a narrow internal tool",
        avgNote: "a typical agent processing some untrusted user/web content",
        highNote: "an agent that reads directly from adversarial or attacker-reachable sources",
      },
    },
    {
      key: "promptCacheHitRate",
      label: "Prompt Cache Hit Rate",
      shortLabel: "cache",
      type: "percent",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0,
      unit: "%",
      description:
        "docs/Agentic_AI.md §2.9's prompt caching — provider-side caching of a previously-seen prompt prefix, billed at roughly 1/10th price, distinct from semantic caching (Cache's own Caching Mode): this reduces the cost of a call that still happens, it doesn't skip the call the way a Cache hit upstream does. Fraction of this node's tokens that share a cached prefix with a recent call — feeds costEngine.ts's llmCallPricing as a direct discount on the usage-cost rate. Latency and reliability are unaffected; only the dollar figure changes.",
      impact:
        "Raise it to model consecutive calls sharing a long, stable prompt prefix (a fixed system prompt, a large repeated context) — the cost readout drops toward roughly 1/10th of the undiscounted rate as this approaches 100%.",
      benchmark: {
        low: 0,
        avg: 0.3,
        high: 0.8,
        lowNote: "no shared prefix — every call's full prompt is genuinely novel",
        avgNote: "a typical agent loop reusing a stable system prompt/context across calls",
        highNote: "a long, mostly-fixed prompt prefix with only a small novel suffix per call",
      },
    },
  ],
  tool_call: [
    {
      key: "maxConcurrent",
      label: "Max Concurrent",
      shortLabel: "max",
      type: "number",
      min: 1,
      max: 100,
      step: 1,
      default: 15,
      description:
        "External calls this node can have in flight at once. Raise it to admit more concurrent calls before anything queues — the realistic ceiling is whatever the real external API/service allows, not a free lever. Lower it to see the same traffic start backing up and failing sooner.",
      impact:
        "Raise it to admit more concurrent external calls before anything queues — the realistic ceiling is the external service's own rate limit.",
      benchmark: {
        low: 2,
        avg: 15,
        high: 50,
        lowNote: "a tightly rate-limited external API",
        avgNote: "a typical external service integration",
        highNote: "a high-throughput internal service call",
      },
    },
    {
      key: "maxQueueLength",
      label: "Max Queue Length",
      shortLabel: "queue",
      type: "number",
      min: 0,
      max: 300,
      step: 1,
      default: 100,
      description:
        "Calls allowed to wait once Max Concurrent is reached, before being rejected. Raise it to absorb a burst without dropping calls, at the cost of higher latency for whatever's waiting. Lower it (or set 0) to reject overflow immediately.",
      impact:
        "Raise it to absorb a burst of tool calls without rejecting any, at the cost of higher latency for whatever's waiting.",
      benchmark: {
        low: 0,
        avg: 100,
        high: 250,
        lowNote: "fail-fast — reject overflow immediately",
        avgNote: "absorbs a normal burst",
        highNote: "deep buffering for a bursty caller",
      },
    },
    {
      key: "processingTimeMs",
      label: "Call Duration",
      shortLabel: "dur",
      type: "number",
      min: 5,
      max: 3000,
      step: 5,
      default: 120,
      unit: "ms",
      description:
        "Time for the external call to complete — a real API round trip, a database query, a function execution. Raise it to model a slower external dependency; lower it to model a fast, local function call.",
      impact:
        "Raise it to model a slower external dependency — each call occupies a concurrency slot longer, lowering effective throughput even with Max Concurrent unchanged.",
      benchmark: {
        low: 5,
        avg: 120,
        high: 1000,
        lowNote: "a fast local function call",
        avgNote: "a typical external API round trip",
        highNote: "a slow external dependency — a heavy query, a rate-limited third-party API",
      },
    },
    {
      key: "failureRate",
      label: "Failure Rate",
      shortLabel: "fail",
      type: "percent",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.02,
      unit: "%",
      description:
        "Chance the external call itself fails outright or comes back unavailable — a stand-in for the tool erroring or timing out. Distinct from Silent Failure Rate below (a call that comes back 200-but-empty instead of erroring): this dial fails loudly, that one doesn't. Raise it to test whether a guardrail or retry logic upstream actually helps; 0 means the external dependency is always reliable.",
      impact:
        "Raise it to see failures appear from the external dependency itself, independent of load — and to test whether anything upstream actually handles it.",
      benchmark: {
        low: 0,
        avg: 0.02,
        high: 0.15,
        lowNote: "a reliable, well-maintained internal service",
        avgNote: "a typical third-party API with occasional blips",
        highNote: "a flaky or degraded external dependency",
      },
    },
    {
      key: "schemaFailureRate",
      label: "Schema Failure Rate",
      shortLabel: "schema",
      type: "percent",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.02,
      unit: "%",
      description:
        "Chance this tool's response doesn't match the shape the calling llm_call expected — a field renamed, a type changed, an undocumented API version bump. Checked before Failure Rate on every call, since a malformed response is a more specific signal than a generic failure.",
      impact:
        "Raise it to simulate an external API whose response shape isn't as stable as the caller assumes — the real-world mitigation is validating the response before trusting it downstream.",
      benchmark: {
        low: 0,
        avg: 0.02,
        high: 0.1,
        lowNote: "a stable, versioned, well-documented API contract",
        avgNote: "a typical third-party integration",
        highNote: "an undocumented or frequently-changing external API",
      },
    },
    {
      key: "hallucinatedInvocationRate",
      label: "Hallucinated Invocation Rate",
      shortLabel: "halluc",
      type: "percent",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.02,
      unit: "%",
      description:
        "Chance the calling model invoked a tool that was never really registered or reachable — docs/Agentic_AI.md §1.7's failure mode #2. Checked before every other roll: a hallucinated invocation never legitimately reached a real external system, so there's no schema and no call to fail — just a dispatch that should never have happened. Fails with reason 'hallucinated_tool_call', distinct from Schema Failure Rate and Failure Rate.",
      impact:
        "Raise it to simulate a model that isn't reliably grounded in its actual registered tool set. Pre-dispatch structured-output validation upstream is the real-world mitigation — this dial is what that validation is meant to catch before it ever reaches here.",
      benchmark: {
        low: 0,
        avg: 0.02,
        high: 0.12,
        lowNote: "structured-output enforcement, a small well-documented tool set",
        avgNote: "a typical agent with a moderate tool registry",
        highNote: "a large or ambiguous tool set the model frequently confuses",
      },
    },
    {
      key: "silentFailureRate",
      label: "Silent Failure Rate",
      shortLabel: "silent",
      type: "percent",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.03,
      unit: "%",
      description:
        "Chance a successful call quietly comes back 200-but-empty (or otherwise malformed with no error surfaced) instead of failing outright — docs/Agentic_AI.md §1.7's failure mode #4, properly modeled: not a failure, a compromise. The request completes looking fine; only a Guardrail Validator wired downstream (its Compromise Catch Rate) has any chance of noticing.",
      impact:
        "Raise it to see how often a clean-looking success is actually empty inside. With no Guardrail Validator downstream, nothing catches it — invisible in every metric except the trace.",
      benchmark: {
        low: 0,
        avg: 0.03,
        high: 0.15,
        lowNote: "a well-behaved API that always errors loudly when it fails",
        avgNote: "a typical third-party integration",
        highNote: "a poorly-behaved API known to return empty success payloads",
      },
    },
    {
      key: "perCallCostUsd",
      label: "Cost / Call",
      shortLabel: "cost",
      type: "number",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0.005,
      unit: "$",
      description:
        "Flat cost charged per call, for a paid external API or metered service — a free internal function call is 0. Feeds directly into the cost readout, extrapolated the same way every other priced entity's usage cost is: observed call rate multiplied out to a monthly volume.",
      impact:
        "Raise it to model a metered/paid external API; 0 models a free internal call. The monthly cost readout scales directly with this and with traffic volume.",
      benchmark: {
        low: 0,
        avg: 0.005,
        high: 0.05,
        lowNote: "a free internal function call",
        avgNote: "a typical metered third-party API",
        highNote: "an expensive specialized API (e.g. a paid data enrichment or search provider)",
      },
    },
  ],
  agent_orchestrator: [
    {
      key: "routingMode",
      label: "Routing Mode",
      shortLabel: "mode",
      type: "select",
      default: "sequential",
      options: [
        { value: "sequential", label: "Sequential — Planning" },
        { value: "parallel", label: "Parallel — Orchestrator-Worker" },
      ],
      description:
        "Sequential dispatches to each downstream target one at a time, in order, only moving to the next once the current one succeeds — the Planning pattern: a task broken into an ordered sequence of subtasks. Parallel dispatches to every downstream target at once and waits for all of them before responding — the Orchestrator-Worker pattern: heterogeneous work fanned out for parallel latency reduction, then synthesized. Orchestrator-Worker is real overkill for a linear, dependent workflow — its whole value is subtasks that are actually independent and worth the extra concurrent-call cost.",
      impact:
        "Sequential is the right default for dependent steps (each needs the previous one's result). Parallel only pays for itself when downstream targets do genuinely independent work — otherwise it's concurrent-call cost with no latency win.",
    },
    {
      key: "maxIterations",
      label: "Max Iterations",
      shortLabel: "iter",
      type: "number",
      min: 1,
      max: 1000,
      step: 1,
      default: 3,
      unit: "attempts",
      description:
        "Total attempts allowed per step (Sequential) or per worker (Parallel), including the first, before giving up on it. This is the entity's whole reason for existing per docs/Agentic_AI.md: it owns the loop that can be the site of failure mode #5, the infinite retry loop — a failed call retried identically with no recognition it keeps failing the same way. Set low, a genuinely flaky downstream call fails fast. Set very high against an always-failing target, watch that target's own request count balloon far past what one logical request should ever cause — the failure mode made visible, not asserted.",
      impact:
        "The real protection against a runaway retry loop. A low value fails fast on a genuinely broken dependency; a very high value against a consistently-failing target is exactly failure mode #5 reproduced on purpose.",
      benchmark: {
        low: 1,
        avg: 3,
        high: 200,
        lowNote: "no retry at all — fail immediately on the first failure",
        avgNote: "a typical small retry budget",
        highNote: "effectively unbounded — the infinite-retry-loop failure mode, reproduced against a consistently-failing target",
      },
    },
    {
      key: "maxConcurrent",
      label: "Max Concurrent",
      shortLabel: "max",
      type: "number",
      min: 1,
      max: 100,
      step: 1,
      default: 10,
      description:
        "Sessions this node can be actively coordinating at once — held for a session's entire lifetime (every step or worker, every retry), not just one hop, since a real orchestrator genuinely holds session state for as long as it's coordinating. Raise it to coordinate more concurrent agent runs before anything queues.",
      impact:
        "Raise it to coordinate more concurrent sessions before anything queues — each held slot lasts the whole session, not just one dispatch.",
      benchmark: {
        low: 2,
        avg: 10,
        high: 50,
        lowNote: "a small, lightly-provisioned orchestration service",
        avgNote: "a typical mid-sized deployment",
        highNote: "a large, highly concurrent orchestration service",
      },
    },
    {
      key: "maxQueueLength",
      label: "Max Queue Length",
      shortLabel: "queue",
      type: "number",
      min: 0,
      max: 200,
      step: 1,
      default: 50,
      description:
        "Sessions allowed to wait once Max Concurrent is reached, before being rejected. Raise it to absorb a burst of incoming agent runs without dropping any, at the cost of every waiting one starting later.",
      impact:
        "Raise it to absorb a burst of incoming sessions without rejecting any, at the cost of a longer wait before each one starts.",
      benchmark: {
        low: 0,
        avg: 50,
        high: 150,
        lowNote: "fail-fast — reject overflow immediately",
        avgNote: "absorbs a normal burst",
        highNote: "deep buffering for a bursty caller",
      },
    },
    {
      key: "processingTimeMs",
      label: "Planning Overhead",
      shortLabel: "plan",
      type: "number",
      min: 0,
      max: 500,
      step: 5,
      default: 50,
      unit: "ms",
      description:
        "One-time delay before the first dispatch of a new session — the orchestrator's own reasoning cost in deciding what to do (which steps, which workers), maps to the reasoning time inside an invoke_agent span. Not repeated per step or per retry, a deliberate simplification: only the initial plan pays this cost here.",
      impact:
        "Raise it to model a more deliberate planning step before any work actually starts. Retries and later steps don't re-pay this — only the first dispatch does.",
      benchmark: {
        low: 0,
        avg: 50,
        high: 300,
        lowNote: "a trivial routing decision — barely any deliberation",
        avgNote: "a typical planning step before dispatching subtasks",
        highNote: "a genuinely deliberate multi-step plan being reasoned out before anything is dispatched",
      },
    },
  ],
  memory_context_store: [
    {
      key: "compactionPolicy",
      label: "Compaction Policy",
      shortLabel: "policy",
      type: "select",
      default: "none",
      options: [
        { value: "none", label: "None — truncate oldest" },
        { value: "summarization", label: "Summarization" },
        { value: "scratchpad", label: "Scratchpad / file" },
      ],
      description:
        "What happens once this session's running context exceeds Capacity. None drops the oldest content instantly and for free — the deliberate 'watch context rot happen' option: the first time it fires, this session's original critical info is gone for good. Summarization compresses instead of dropping, at the cost of extra latency on the compacting turn, and mostly (not always) keeps critical info intact. Scratchpad — Anthropic's own documented pattern — writes overflow to a file outside the context window: critical info almost always survives, but every turn after that costs a re-read.",
      impact:
        "None is fast until it silently drops critical info forever. Summarization and Scratchpad both trade latency for keeping that info intact longer — Scratchpad pays that cost on every subsequent turn, Summarization only on turns that actually compact.",
    },
    {
      key: "capacityTokens",
      label: "Capacity",
      shortLabel: "cap",
      type: "number",
      min: 500,
      max: 50000,
      step: 100,
      default: 8000,
      unit: "tokens",
      description:
        "Size of the context window. Once the running session's accumulated size (Tokens / Turn × turns handled) exceeds this, the Compaction Policy above triggers. Lower it to see compaction happen sooner in a run; raise it to delay when the trade-offs above start to matter.",
      impact:
        "Lower it to trigger compaction earlier in the session; raise it to delay the point where the Compaction Policy's trade-offs kick in.",
      benchmark: {
        low: 2000,
        avg: 8000,
        high: 32000,
        lowNote: "a small window — an older or budget-tier model",
        avgNote: "a typical single-session assistant conversation budget",
        highNote: "a large single-session window before compaction matters at all",
      },
    },
    {
      key: "tokensPerTurn",
      label: "Tokens / Turn",
      shortLabel: "turn",
      type: "number",
      min: 50,
      max: 5000,
      step: 50,
      default: 500,
      unit: "tokens",
      description:
        "How much each turn this node handles adds to the running session's context size. Raise it to simulate turns that carry a lot of content (a large tool result, a pasted document); lower it for short, terse exchanges.",
      impact:
        "Raise it to fill the context window faster with the same Capacity — the fastest way to see Compaction Policy's trade-offs play out inside a short run.",
      benchmark: {
        low: 100,
        avg: 500,
        high: 2000,
        lowNote: "a short, terse back-and-forth",
        avgNote: "a typical tool-using agent turn with some carried context",
        highNote: "a turn carrying a large tool result or pasted document",
      },
    },
    {
      key: "summarizationOverheadMs",
      label: "Summarization Overhead",
      shortLabel: "sum ms",
      type: "number",
      min: 0,
      max: 2000,
      step: 10,
      default: 150,
      unit: "ms",
      description:
        "Extra latency on a turn that triggers a summarization pass — only meaningful under the Summarization policy. Raise it to model a more expensive compression step (an extra model call to write the summary).",
      impact:
        "Only affects turns where Summarization actually compacts. Raise it to make the summarization step itself a more visible cost.",
      benchmark: {
        low: 0,
        avg: 150,
        high: 800,
        lowNote: "a cheap, fast compression pass",
        avgNote: "a typical extra summarization call",
        highNote: "a heavyweight summarization step over a large history",
      },
    },
    {
      key: "summarizationInfoLossRate",
      label: "Summarization Info Loss",
      shortLabel: "sum loss",
      type: "percent",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.1,
      unit: "%",
      description:
        "Chance a summarization pass loses the critical info anyway — only meaningful under the Summarization policy, and only rolled while that info is still intact. Summarization mostly preserves it, but 'mostly' isn't 'always'; this is what makes that honest instead of asserting it never fails.",
      impact:
        "Raise it to make Summarization behave more like None over a long enough session — a lower value keeps the two policies clearly distinct in the comparison.",
      benchmark: {
        low: 0,
        avg: 0.1,
        high: 0.4,
        lowNote: "a well-tuned summarization prompt that reliably keeps what matters",
        avgNote: "a typical summarization pass",
        highNote: "a summarization step under real pressure to be terse — starts dropping what it shouldn't",
      },
    },
    {
      key: "scratchpadReadLatencyMs",
      label: "Scratchpad Read Latency",
      shortLabel: "pad ms",
      type: "number",
      min: 0,
      max: 1000,
      step: 10,
      default: 80,
      unit: "ms",
      description:
        "Extra latency on every turn after the scratchpad file first exists — only meaningful under the Scratchpad policy. This is the sustained cost that policy pays that the other two don't: re-reading the file back on every subsequent turn, not just compacting ones.",
      impact:
        "Applies to every turn once Scratchpad has compacted once, not just the compacting turn — raise it to make that ongoing tax more visible in the comparison.",
      benchmark: {
        low: 0,
        avg: 80,
        high: 400,
        lowNote: "a fast local file read",
        avgNote: "a typical external file/blob-store round trip",
        highNote: "a slow or remote scratchpad store",
      },
    },
    {
      key: "scratchpadInfoLossRate",
      label: "Scratchpad Info Loss",
      shortLabel: "pad loss",
      type: "percent",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.01,
      unit: "%",
      description:
        "Chance a scratchpad write itself loses the critical info — only meaningful under the Scratchpad policy, and only rolled while that info is still intact. Deliberately near-zero by default: the documented pattern is genuinely close to lossless, not literally 100% either.",
      impact:
        "Near-zero by default so Scratchpad reads as the clear reliability winner in the comparison — raise it to model a flakier persistence layer.",
      benchmark: {
        low: 0,
        avg: 0.01,
        high: 0.1,
        lowNote: "a reliable, durable persistence layer",
        avgNote: "a typical file/blob store",
        highNote: "a flaky or under-tested persistence layer",
      },
    },
    {
      key: "driftFailureRate",
      label: "Drift Failure Rate",
      shortLabel: "drift",
      type: "percent",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.3,
      unit: "%",
      description:
        "Once critical info is gone, the chance any given turn fails outright with 'context_truncation' — rolled independently every turn from that point on. This is failure mode #3 from the docs/Agentic_AI.md taxonomy made observable: nothing fails the instant info is lost, but downstream behavior starts silently going wrong at this rate.",
      impact:
        "Only matters once a policy above has actually lost the critical info. Raise it to make the downstream consequence of that loss show up faster and more visibly in the metrics.",
      benchmark: {
        low: 0,
        avg: 0.3,
        high: 0.8,
        lowNote: "the session mostly limps along even after losing critical context",
        avgNote: "a typical, meaningfully-degraded session",
        highNote: "the session is essentially broken once critical info is gone",
      },
    },
    {
      key: "maxConcurrent",
      label: "Max Concurrent",
      shortLabel: "max",
      type: "number",
      min: 1,
      max: 200,
      step: 1,
      default: 20,
      description:
        "Turns this node can be actively handling at once. Raise it to admit more concurrent turns before anything queues.",
      impact:
        "Raise it to admit more concurrent turns before anything queues.",
      benchmark: {
        low: 2,
        avg: 20,
        high: 128,
        lowNote: "a small, lightly-provisioned deployment",
        avgNote: "a typical mid-sized deployment",
        highNote: "a large, highly concurrent deployment",
      },
    },
    {
      key: "maxQueueLength",
      label: "Max Queue Length",
      shortLabel: "queue",
      type: "number",
      min: 0,
      max: 300,
      step: 1,
      default: 100,
      description:
        "Turns allowed to wait once Max Concurrent is reached, before being rejected. Raise it to absorb a burst without dropping any, at the cost of higher latency for whatever's waiting.",
      impact:
        "Raise it to absorb a burst of turns without rejecting any, at the cost of higher latency for whatever's waiting.",
      benchmark: {
        low: 0,
        avg: 100,
        high: 250,
        lowNote: "fail-fast — reject overflow immediately",
        avgNote: "absorbs a normal burst",
        highNote: "deep buffering for a bursty caller",
      },
    },
    {
      key: "processingTimeMs",
      label: "Base Overhead",
      shortLabel: "base",
      type: "number",
      min: 0,
      max: 500,
      step: 5,
      default: 10,
      unit: "ms",
      description:
        "Base bookkeeping time per turn, before any compaction-specific overhead above is added. Deliberately small by default — reading/writing the context window is cheap; compaction is where the real cost lives.",
      impact:
        "Raise it to model a store with real per-turn overhead independent of compaction (e.g. one backed by a slower external store).",
      benchmark: {
        low: 0,
        avg: 10,
        high: 100,
        lowNote: "an in-memory store — effectively free",
        avgNote: "a typical lightweight store",
        highNote: "a store backed by a slower external system",
      },
    },
  ],
  retriever: [
    {
      key: "mode",
      label: "Mode",
      shortLabel: "mode",
      type: "select",
      default: "pipeline",
      options: [
        { value: "pipeline", label: "Pipeline — single-shot top-k" },
        { value: "agentic", label: "Agentic — retrieve, critique, re-retrieve" },
        { value: "graphrag", label: "GraphRAG — entity/relationship traversal" },
        { value: "adaptive", label: "Adaptive — routes to the cheapest that can answer" },
      ],
      description:
        "Pipeline is the 2023-era baseline: embed, fetch top-k, generate — one shot, no self-correction. Agentic turns retrieval into a bounded loop that critiques and re-retrieves, up to Max Retrieval Attempts, but without redundancy it can 'self-correct into a more elaborate hallucination' if it never resolves. GraphRAG retrieves via graph traversal instead of chunk similarity — slower and a little less reliable on an ordinary lookup, but wins decisively on queries that genuinely need relationship reasoning (see the Client's Relationship Query Rate). Adaptive routes each query to whichever of Pipeline or GraphRAG can actually answer it, reusing their real behavior rather than a separate model of its own.",
      impact:
        "No mode strictly dominates — each trades latency, cost, and accuracy differently, and only GraphRAG (or Adaptive routing into it) meaningfully handles relationship-shaped traffic at all. Compare all four on identical traffic to see which trade-off actually fits.",
    },
    {
      key: "processingTimeMs",
      label: "Retrieval Time",
      shortLabel: "time",
      type: "number",
      min: 5,
      max: 2000,
      step: 5,
      default: 80,
      unit: "ms",
      description:
        "Base time for one chunk-similarity retrieval attempt — used directly by Pipeline, once per attempt by Agentic, and on Adaptive's non-relationship path. Raise it to model a larger or less-optimized vector index.",
      impact:
        "Raise it to model a slower embedding/vector-search step. Under Agentic, this cost is paid on every attempt, not just once.",
      benchmark: {
        low: 15,
        avg: 80,
        high: 400,
        lowNote: "a small, well-optimized vector index",
        avgNote: "a typical production embedding + vector search round trip",
        highNote: "a large, unoptimized, or remote vector store",
      },
    },
    {
      key: "missRate",
      label: "Miss Rate",
      shortLabel: "miss",
      type: "percent",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.12,
      unit: "%",
      description:
        "Chance a single chunk-similarity retrieval attempt fails to surface the chunk that actually answers the query. Applies to Pipeline directly, per attempt under Agentic, and on Adaptive's non-relationship path.",
      impact:
        "Raise it to model a harder corpus or a less-tuned embedding model. Under Agentic, a higher rate means more attempts (and more latency/cost) are typically needed to resolve.",
      benchmark: {
        low: 0.02,
        avg: 0.12,
        high: 0.35,
        lowNote: "a small, well-curated, narrow-domain corpus",
        avgNote: "a typical general-purpose knowledge base",
        highNote: "a large, noisy, or poorly-chunked corpus",
      },
    },
    {
      key: "relationshipPenaltyMultiplier",
      label: "Relationship Penalty",
      shortLabel: "rel pen",
      type: "number",
      min: 1,
      max: 20,
      step: 0.5,
      default: 4,
      unit: "x",
      description:
        "Multiplies Miss Rate when a request needs multi-hop relationship reasoning (the Client's Relationship Query Rate) — chunk similarity search structurally struggles with 'which vendors does our highest-risk supplier also share with?' no matter how good the embeddings are. Applies to Pipeline and Agentic; GraphRAG has the opposite dial (Relationship Bonus) instead.",
      impact:
        "Raise it to make chunk-based retrieval's weakness on relationship-shaped traffic more pronounced — this is the number that makes GraphRAG's advantage on the same traffic worth measuring.",
      benchmark: {
        low: 1,
        avg: 4,
        high: 10,
        lowNote: "relationship queries are barely harder than ordinary ones — an unrealistic best case",
        avgNote: "a typical, meaningful gap on genuinely multi-hop questions",
        highNote: "chunk similarity is close to useless on this traffic",
      },
    },
    {
      key: "maxRetrievalAttempts",
      label: "Max Retrieval Attempts",
      shortLabel: "attempts",
      type: "number",
      min: 1,
      max: 10,
      step: 1,
      default: 3,
      unit: "attempts",
      description:
        "Total retrieve-critique-reretrieve cycles Agentic mode allows before giving up on a query. Only meaningful under Agentic. A low value fails (or hallucinates) fast; a high value gives more chances to resolve, at proportionally higher latency and cost when it actually needs them.",
      impact:
        "Only affects Agentic. Raise it to give harder queries more chances to resolve — but every extra attempt costs real latency and money whether or not it ends up needed.",
      benchmark: {
        low: 1,
        avg: 3,
        high: 6,
        lowNote: "no real self-correction — behaves close to Pipeline",
        avgNote: "a typical bounded retry budget",
        highNote: "a generous budget — high cost on the queries that need every attempt",
      },
    },
    {
      key: "critiqueOverheadMs",
      label: "Critique Overhead",
      shortLabel: "critique",
      type: "number",
      min: 0,
      max: 500,
      step: 5,
      default: 60,
      unit: "ms",
      description:
        "Extra latency on every Agentic attempt for the critique/self-assessment step that decides whether to stop or re-retrieve. Only meaningful under Agentic.",
      impact:
        "Only affects Agentic. Raise it to model a more deliberate critique step — paid on every attempt, so it compounds with Max Retrieval Attempts.",
      benchmark: {
        low: 0,
        avg: 60,
        high: 250,
        lowNote: "a cheap, fast relevance check",
        avgNote: "a typical self-critique step",
        highNote: "a heavyweight critique call",
      },
    },
    {
      key: "unresolvedHallucinationRate",
      label: "Unresolved Hallucination Rate",
      shortLabel: "unresolved",
      type: "percent",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.4,
      unit: "%",
      description:
        "Once Agentic exhausts Max Retrieval Attempts without resolving, this is the chance the final answer comes back confidently wrong (retrieval_hallucination) rather than a plain, honest miss (retrieval_miss). This is the real, documented risk of retrieval-as-a-loop: without redundancy it can self-correct into a more elaborate hallucination instead of just failing honestly. Only meaningful under Agentic.",
      impact:
        "Only affects Agentic, and only once its attempt budget is exhausted. Raise it to make that failure mode's qualitative difference from a plain miss more visible in the trace.",
      benchmark: {
        low: 0,
        avg: 0.4,
        high: 0.8,
        lowNote: "an exhausted loop mostly just gives up honestly",
        avgNote: "a typical mix of honest misses and confident wrong answers",
        highNote: "an exhausted loop is far more likely to sound confident than to sound unsure",
      },
    },
    {
      key: "graphTraversalTimeMs",
      label: "Graph Traversal Time",
      shortLabel: "graph time",
      type: "number",
      min: 10,
      max: 2000,
      step: 10,
      default: 180,
      unit: "ms",
      description:
        "Base time for one graph traversal — replaces Retrieval Time under GraphRAG (and on Adaptive's relationship path). Higher than a vector search by default: traversal isn't free even for a simple lookup, a genuine cost GraphRAG pays regardless of whether the query actually needed it.",
      impact:
        "Raise it to model a larger or less-optimized knowledge graph. This is GraphRAG's real cost even on queries that didn't need relationship reasoning.",
      benchmark: {
        low: 30,
        avg: 180,
        high: 600,
        lowNote: "a small, well-indexed graph",
        avgNote: "a typical production knowledge graph",
        highNote: "a large, deeply-nested graph requiring multi-hop traversal",
      },
    },
    {
      key: "graphMissRateBase",
      label: "GraphRAG Miss Rate",
      shortLabel: "graph miss",
      type: "percent",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.18,
      unit: "%",
      description:
        "GraphRAG's own miss rate on ordinary (non-relationship) queries — deliberately a bit worse than Pipeline's default Miss Rate: GraphRAG isn't a free upgrade, it's a different trade-off that specifically wins elsewhere (see Relationship Bonus below).",
      impact:
        "Raise it to make GraphRAG's cost on ordinary traffic more visible — the honest counterweight to its relationship-query advantage.",
      benchmark: {
        low: 0.05,
        avg: 0.18,
        high: 0.4,
        lowNote: "a well-tuned graph that also handles simple lookups well",
        avgNote: "a typical graph store, better suited to relationship queries than simple ones",
        highNote: "a graph store poorly suited to anything but genuinely relational queries",
      },
    },
    {
      key: "graphRelationshipBonusMultiplier",
      label: "Relationship Bonus",
      shortLabel: "rel bonus",
      type: "number",
      min: 0.01,
      max: 1,
      step: 0.01,
      default: 0.1,
      unit: "x",
      description:
        "Multiplies GraphRAG Miss Rate down when a request needs multi-hop relationship reasoning — the smaller this number, the more decisively GraphRAG wins on exactly the traffic chunk similarity search cannot answer. This is GraphRAG's whole reason for existing, made a real, measurable dial rather than an assertion.",
      impact:
        "Lower it to make GraphRAG's win on relationship-shaped traffic more decisive; raise it toward 1 to see that advantage disappear entirely.",
      benchmark: {
        low: 0.02,
        avg: 0.1,
        high: 0.5,
        lowNote: "GraphRAG is dramatically better on relationship queries — the clear case for it",
        avgNote: "a typical, meaningful advantage",
        highNote: "GraphRAG barely helps on relationship queries — questionable whether it's worth the extra Graph Traversal Time",
      },
    },
    {
      key: "classifierOverheadMs",
      label: "Classifier Overhead",
      shortLabel: "classify",
      type: "number",
      min: 0,
      max: 200,
      step: 5,
      default: 15,
      unit: "ms",
      description:
        "Extra latency for Adaptive's own complexity-classification step, added on top of whichever underlying mode (Pipeline-shaped or GraphRAG-shaped) it routes into. Only meaningful under Adaptive — deliberately small: the classifier is meant to be cheap relative to the retrieval it's routing.",
      impact:
        "Only affects Adaptive. Raise it to model a heavier classification step — if it approaches Retrieval Time itself, Adaptive stops being 'the cheapest pipeline that can answer' and starts adding real overhead of its own.",
      benchmark: {
        low: 0,
        avg: 15,
        high: 80,
        lowNote: "a cheap heuristic or small classifier model",
        avgNote: "a typical lightweight classification call",
        highNote: "a classifier heavy enough to erode Adaptive's own cost advantage",
      },
    },
    {
      key: "costPerQueryUsd",
      label: "Cost / Query",
      shortLabel: "cost",
      type: "number",
      min: 0,
      max: 0.1,
      step: 0.0005,
      default: 0.002,
      unit: "$",
      description:
        "Base embedding + vector-search cost per query. Feeds costEngine.ts's retrieverPricing, which scales this rate per mode: Agentic pays it roughly once per attempt on average, GraphRAG pays a higher flat multiplier (graph queries typically cost more than vector search), Adaptive blends the two.",
      impact:
        "Raise it to model a pricier embedding/vector-search provider. The monthly cost readout scales directly with this, mode, and traffic volume.",
      benchmark: {
        low: 0.0005,
        avg: 0.002,
        high: 0.01,
        lowNote: "a cheap, self-hosted vector search",
        avgNote: "a typical managed vector-search API",
        highNote: "a premium managed retrieval/search API",
      },
    },
    {
      key: "poisonedContentRate",
      label: "Poisoned Content Rate",
      shortLabel: "poison",
      type: "percent",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.02,
      unit: "%",
      description:
        "Chance a successfully resolved retrieval's content is actually poisoned — docs/Agentic_AI.md §1.7's failure mode #10, indirect prompt injection: malicious instructions embedded in retrieved content, reaching the downstream llm_call looking like a perfectly normal result. Only rolled on a resolved attempt (a miss/hallucination has nothing to poison). Only a Guardrail Validator wired between this node and the llm_call (its Compromise Catch Rate) has any chance of catching it first.",
      impact:
        "Raise it to model an untrusted or attacker-reachable corpus. With no Guardrail Validator wired downstream, nothing catches it — invisible in every metric except the trace.",
      benchmark: {
        low: 0,
        avg: 0.02,
        high: 0.1,
        lowNote: "a curated, trusted internal corpus",
        avgNote: "a typical mixed corpus with some external/user-contributed content",
        highNote: "an open, crawlable, or user-editable corpus an attacker can plant content into",
      },
    },
    {
      key: "maxConcurrent",
      label: "Max Concurrent",
      shortLabel: "max",
      type: "number",
      min: 1,
      max: 300,
      step: 1,
      default: 30,
      description:
        "Retrievals this node can be actively running at once. Raise it to admit more concurrent retrievals before anything queues.",
      impact:
        "Raise it to admit more concurrent retrievals before anything queues.",
      benchmark: {
        low: 5,
        avg: 30,
        high: 150,
        lowNote: "a small, lightly-provisioned retrieval service",
        avgNote: "a typical mid-sized deployment",
        highNote: "a large, highly concurrent retrieval service",
      },
    },
    {
      key: "maxQueueLength",
      label: "Max Queue Length",
      shortLabel: "queue",
      type: "number",
      min: 0,
      max: 400,
      step: 1,
      default: 150,
      description:
        "Retrievals allowed to wait once Max Concurrent is reached, before being rejected. Raise it to absorb a burst without dropping any, at the cost of higher latency for whatever's waiting.",
      impact:
        "Raise it to absorb a burst of retrievals without rejecting any, at the cost of higher latency for whatever's waiting.",
      benchmark: {
        low: 0,
        avg: 150,
        high: 350,
        lowNote: "fail-fast — reject overflow immediately",
        avgNote: "absorbs a normal burst",
        highNote: "deep buffering for a bursty caller",
      },
    },
  ],
  guardrail_validator: [
    {
      key: "mode",
      label: "Validation Mode",
      shortLabel: "mode",
      type: "select",
      default: "gate",
      options: [
        { value: "gate", label: "Gate — pass/fail (Reflection)" },
        { value: "scorer", label: "Scorer — graded threshold (Evaluator-Optimizer)" },
      ],
      description:
        "Gate asks a binary question: is this good enough to ship? A rejection fails outright. Scorer asks a graded one instead: how good is this on some scale, and does it clear a threshold? Wire this node downstream of an llm_call, inside a Sequential Agent Orchestrator, to get Reflection (Gate) or Evaluator-Optimizer (Scorer) — the retry loop itself needs no new mechanism, it's the orchestrator's existing iteration-capped retry, now driven by a real pass/fail decision instead of a blind retry count.",
      impact:
        "Gate is the simpler, binary check Reflection uses. Scorer adds a graded threshold and (with Verification Method below) the specific risk Evaluator-Optimizer's own research names.",
    },
    {
      key: "rejectionRate",
      label: "Rejection Rate",
      shortLabel: "reject",
      type: "percent",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.25,
      unit: "%",
      description:
        "Chance a check fails outright. Gate mode only. Wired inside a Sequential Agent Orchestrator's retry loop, this is what makes Reflection's self-critique loop actually run more than once — a lower rate resolves quickly, a higher one exercises the orchestrator's Max Iterations cap harder.",
      impact:
        "Only affects Gate mode. Raise it to make the Reflection loop retry more before finally passing (or exhausting Max Iterations).",
      benchmark: {
        low: 0.05,
        avg: 0.25,
        high: 0.6,
        lowNote: "a lenient check — most attempts pass on the first try",
        avgNote: "a typical, meaningful self-critique bar",
        highNote: "a strict check — the loop leans hard on Max Iterations to ever pass",
      },
    },
    {
      key: "verificationMethod",
      label: "Verification Method",
      shortLabel: "verify",
      type: "select",
      default: "execution",
      options: [
        { value: "execution", label: "Execution-based — a real, checkable outcome" },
        { value: "judge", label: "Judge-based — another model's own judgment" },
      ],
      description:
        "Scorer mode only. Execution-based grounds the score in something real (a test suite passing, a database's actual end state) — no drift, however many times the same request is retried. Judge-based is vulnerable to exactly the failure mode Evaluator-Optimizer's own research names: a same-model judge grading the output tends to score later retries of the identical request more leniently (Judge Drift / Attempt below) without the underlying answer actually improving — 'self-corrects into a more elaborate hallucination.'",
      impact:
        "Execution-based never drifts, however many retries occur. Judge-based drifts upward per retry via Judge Drift / Attempt — compare the two on identical traffic to see the real risk instead of taking it on faith.",
    },
    {
      key: "scoreMean",
      label: "Score Mean",
      shortLabel: "mean",
      type: "percent",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.55,
      unit: "%",
      description:
        "The 'true' quality each attempt scores around. Scorer mode only. Deliberately held roughly constant across retries of the same request — nothing in this loop actually makes the underlying answer better on its own, which is exactly what makes Judge Drift (under Judge-based verification) a real risk rather than genuine improvement.",
      impact:
        "Raise it to model an optimizer that's already close to good — lower it to model a genuinely hard task that needs real help to clear the threshold, not just more attempts.",
      benchmark: {
        low: 0.3,
        avg: 0.55,
        high: 0.8,
        lowNote: "a hard task — most single attempts fall well short of a typical threshold",
        avgNote: "a typical task — attempts cluster near a realistic pass/fail line",
        highNote: "an easy task — most single attempts already clear a typical threshold",
      },
    },
    {
      key: "scoreJitter",
      label: "Score Jitter",
      shortLabel: "jitter",
      type: "percent",
      min: 0,
      max: 0.5,
      step: 0.01,
      default: 0.15,
      unit: "%",
      description:
        "Random +/- variance applied to Score Mean on every check. Scorer mode only. Raise it to model a noisier, less consistent scoring signal.",
      impact:
        "Raise it to model more run-to-run variance in how a given attempt scores, independent of whether the underlying answer is actually better or worse.",
      benchmark: {
        low: 0.02,
        avg: 0.15,
        high: 0.35,
        lowNote: "a tight, consistent scoring signal",
        avgNote: "a typical amount of scoring noise",
        highNote: "a noisy, inconsistent scorer",
      },
    },
    {
      key: "scoreThreshold",
      label: "Score Threshold",
      shortLabel: "threshold",
      type: "percent",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.7,
      unit: "%",
      description:
        "Minimum score required to pass. Scorer mode only. Raise it for a stricter bar (more retries, more chances for Judge Drift to matter under Judge-based verification); lower it for a more lenient one.",
      impact:
        "Raise it to demand a higher bar before the loop stops — the stricter the threshold, the more retries accumulate, and the more Judge Drift (if Judge-based) has room to compound.",
      benchmark: {
        low: 0.4,
        avg: 0.7,
        high: 0.9,
        lowNote: "a lenient bar — most attempts pass quickly",
        avgNote: "a typical, meaningful quality bar",
        highNote: "a strict bar — the loop leans hard on Max Iterations, and on Judge Drift if configured",
      },
    },
    {
      key: "judgeDriftPerAttempt",
      label: "Judge Drift / Attempt",
      shortLabel: "drift",
      type: "percent",
      min: 0,
      max: 0.5,
      step: 0.01,
      default: 0.08,
      unit: "%",
      description:
        "Added to the score on every retry of the same request — Judge-based verification only. This is 'sounds more confident and more polished each time, without actually getting more correct' made a real, measurable dial: Score Mean itself never moves, but the effective pass bar gets easier to clear purely from repetition.",
      impact:
        "Only affects Judge-based verification. Raise it to make the drift risk more pronounced — compare against Execution-based (which never drifts) on identical traffic to see how much of a 'pass' is real improvement versus just a more lenient re-grade.",
      benchmark: {
        low: 0,
        avg: 0.08,
        high: 0.25,
        lowNote: "a disciplined judge — barely more lenient on a retry",
        avgNote: "a typical same-model judge grading its own retried output",
        highNote: "a judge that's dramatically more lenient by the third or fourth retry",
      },
    },
    {
      key: "compromiseCatchRate",
      label: "Compromise Catch Rate",
      shortLabel: "catch",
      type: "percent",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.85,
      unit: "%",
      description:
        "Chance an incoming request already flagged compromised (Tool Call's Silent Failure Rate, LLM Call's Prompt Injection Rate, or Retriever's Poisoned Content Rate — failure modes #4/#9/#10) is actually caught here, failing with the specific reason that compromised it. Checked before this node's own Mode (gate/scorer) evaluation, on every request that's already carrying the flag — content-safety and output-quality are independent checks, each with its own chance to catch a problem.",
      impact:
        "Raise it to model a more effective content-safety check. With no Guardrail Validator wired downstream of a compromised node at all, this dial never even runs — the compromise reaches the client looking like a clean success.",
      benchmark: {
        low: 0.3,
        avg: 0.85,
        high: 0.99,
        lowNote: "a weak or narrowly-scoped safety check",
        avgNote: "a typical, reasonably effective guardrail",
        highNote: "a rigorous, purpose-built content-safety layer",
      },
    },
    {
      key: "maxConcurrent",
      label: "Max Concurrent",
      shortLabel: "max",
      type: "number",
      min: 1,
      max: 300,
      step: 1,
      default: 30,
      description:
        "Checks this node can be actively running at once. Raise it to admit more concurrent checks before anything queues.",
      impact:
        "Raise it to admit more concurrent checks before anything queues.",
      benchmark: {
        low: 5,
        avg: 30,
        high: 150,
        lowNote: "a small, lightly-provisioned validation service",
        avgNote: "a typical mid-sized deployment",
        highNote: "a large, highly concurrent validation service",
      },
    },
    {
      key: "maxQueueLength",
      label: "Max Queue Length",
      shortLabel: "queue",
      type: "number",
      min: 0,
      max: 400,
      step: 1,
      default: 150,
      description:
        "Checks allowed to wait once Max Concurrent is reached, before being rejected. Raise it to absorb a burst without dropping any, at the cost of higher latency for whatever's waiting.",
      impact:
        "Raise it to absorb a burst of checks without rejecting any, at the cost of higher latency for whatever's waiting.",
      benchmark: {
        low: 0,
        avg: 150,
        high: 350,
        lowNote: "fail-fast — reject overflow immediately",
        avgNote: "absorbs a normal burst",
        highNote: "deep buffering for a bursty caller",
      },
    },
    {
      key: "processingTimeMs",
      label: "Check Time",
      shortLabel: "time",
      type: "number",
      min: 5,
      max: 1000,
      step: 5,
      default: 60,
      unit: "ms",
      description:
        "Base time for one check to run — a rule evaluation, a real test suite, or a judge model's own scoring call. Raise it to model a heavier check (e.g. actually running tests) or a Judge-based verification method's own model-call latency.",
      impact:
        "Raise it to model a more expensive check — this cost is paid on every attempt, so it compounds with however many retries the loop ends up needing.",
      benchmark: {
        low: 5,
        avg: 60,
        high: 400,
        lowNote: "a cheap rule/heuristic check",
        avgNote: "a typical validation step",
        highNote: "a heavyweight check — a real test suite run, or a judge model's own call",
      },
    },
    {
      key: "processingJitterMs",
      label: "Check Time Jitter",
      shortLabel: "jitter ms",
      type: "number",
      min: 0,
      max: 500,
      step: 5,
      default: 20,
      unit: "ms",
      description: "Random +/- variance applied to Check Time on every check.",
      impact: "Raise it to model a less consistent check duration run to run.",
      benchmark: {
        low: 0,
        avg: 20,
        high: 100,
        lowNote: "a very consistent, predictable check",
        avgNote: "a typical amount of timing variance",
        highNote: "a highly variable check duration",
      },
    },
  ],
  model_router: [
    {
      key: "mode",
      label: "Mode",
      shortLabel: "mode",
      type: "select",
      default: "confidence_cascade",
      options: [
        { value: "always_llm", label: "Always-LLM" },
        { value: "always_slm", label: "Always-SLM" },
        { value: "confidence_cascade", label: "Confidence-cascade" },
        { value: "cost_optimized_cascade", label: "Cost-optimized-cascade" },
      ],
      description:
        "Always-LLM and Always-SLM are the two baselines every cascade is measured against — expensive-and-reliable vs. cheap-and-less-reliable, no routing logic at all. Confidence-cascade escalates to the LLM target only when a per-request confidence draw falls below Confidence Threshold — the same threshold applies no matter how much traffic has already escalated. Cost-optimized-cascade adds a hard budget: escalation is additionally capped by Max Escalation Rate, so once too much recent traffic has already escalated, further escalations are suppressed even when confidence alone called for one.",
      impact:
        "The first downstream connection you wire is always the SLM/cheap target, the second is always the LLM/escalation target — same wiring-order convention Agent Orchestrator's Sequential steps already use, no per-connection config needed. Compare all four modes on identical traffic to see the real cost/accuracy trade-off the 90/10 rule describes.",
    },
    {
      key: "slmConfidenceMean",
      label: "SLM Confidence Mean",
      shortLabel: "conf",
      type: "percent",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.65,
      unit: "%",
      description:
        "Mean of the SLM's own self-reported confidence per request — a stand-in for calibration (does the SLM know what it doesn't know), not task difficulty. Cascade modes only. Raise it to model a better-calibrated, more self-aware SLM that escalates less often.",
      impact:
        "Only affects the cascade modes. Raise it to reduce how often the SLM's own confidence falls below the threshold and triggers an escalation attempt.",
      benchmark: {
        low: 0.3,
        avg: 0.65,
        high: 0.9,
        lowNote: "a poorly-calibrated SLM — escalates on most requests",
        avgNote: "a typical SLM's self-reported confidence",
        highNote: "a well-calibrated, highly self-aware SLM — rarely escalates",
      },
    },
    {
      key: "slmConfidenceJitter",
      label: "SLM Confidence Jitter",
      shortLabel: "jitter",
      type: "percent",
      min: 0,
      max: 0.5,
      step: 0.01,
      default: 0.2,
      unit: "%",
      description: "Random +/- variance applied to SLM Confidence Mean on every request. Cascade modes only.",
      impact: "Raise it to model a noisier, less consistent confidence signal.",
      benchmark: {
        low: 0.02,
        avg: 0.2,
        high: 0.4,
        lowNote: "a tight, consistent confidence signal",
        avgNote: "a typical amount of variance",
        highNote: "a noisy, inconsistent confidence signal",
      },
    },
    {
      key: "confidenceThreshold",
      label: "Confidence Threshold",
      shortLabel: "threshold",
      type: "percent",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.6,
      unit: "%",
      description:
        "Escalates to the LLM target when the confidence draw falls below this. Cascade modes only. Raise it for a more cautious router that escalates more often; lower it to keep more traffic on the cheap SLM target.",
      impact:
        "Raise it to escalate more traffic to the LLM target (higher cost, higher reliability); lower it to keep more traffic on the SLM target (cheaper, less reliable).",
      benchmark: {
        low: 0.2,
        avg: 0.6,
        high: 0.9,
        lowNote: "a permissive router — only the least-confident requests escalate",
        avgNote: "a typical, meaningful escalation bar",
        highNote: "a cautious router — most requests escalate, eroding the SLM's cost advantage",
      },
    },
    {
      key: "maxEscalationRate",
      label: "Max Escalation Rate",
      shortLabel: "max esc",
      type: "percent",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.3,
      unit: "%",
      description:
        "Hard cap on what fraction of routed traffic is allowed to escalate, tracked over the run so far. Cost-optimized-cascade only. This is the literal 'budget-aware threshold' — once too much recent traffic has already escalated, further escalations are suppressed even when Confidence Threshold alone called for one.",
      impact:
        "Only affects Cost-optimized-cascade. Lower it for a hard cost ceiling that trades away some accuracy on requests that genuinely needed escalation; raise it toward 1 to let it behave closer to plain Confidence-cascade.",
      benchmark: {
        low: 0.1,
        avg: 0.3,
        high: 0.7,
        lowNote: "a strict budget — most escalation requests get suppressed once the cap is hit",
        avgNote: "a typical budget allowance",
        highNote: "a loose budget — close to unthrottled Confidence-cascade",
      },
    },
  ],
  human_in_loop_gate: [
    {
      key: "approvalLatencyMs",
      label: "Approval Latency",
      shortLabel: "latency",
      type: "number",
      min: 0,
      max: 60_000,
      step: 100,
      default: 4000,
      unit: "ms",
      description:
        "The review delay itself — this entity's whole reason for existing: a real human doesn't decide instantly. Raise it to model a slower, more deliberate review (an on-call engineer paged for approval, a compliance sign-off); lower it toward 0 to isolate Denial Rate's effect from the latency tax.",
      impact:
        "Raise it to see this gate's real cost as a pure latency tax on every request that reaches it, independent of whether it ends up approving or denying.",
      benchmark: {
        low: 500,
        avg: 4000,
        high: 30_000,
        lowNote: "a fast, lightweight rubber-stamp check",
        avgNote: "a typical paged human reviewer",
        highNote: "a slow, deliberate compliance or legal sign-off",
      },
    },
    {
      key: "approvalLatencyJitterMs",
      label: "Approval Latency Jitter",
      shortLabel: "jitter",
      type: "number",
      min: 0,
      max: 30_000,
      step: 100,
      default: 1500,
      unit: "ms",
      description: "Random +/- variance applied to Approval Latency on every request — a real reviewer's response time is never perfectly consistent.",
      impact: "Raise it to model a less consistent, more variable reviewer response time.",
      benchmark: {
        low: 0,
        avg: 1500,
        high: 10_000,
        lowNote: "a highly consistent, on-call reviewer",
        avgNote: "a typical human reviewer's variance",
        highNote: "a reviewer whose availability swings widely",
      },
    },
    {
      key: "denialRate",
      label: "Denial Rate",
      shortLabel: "deny",
      type: "percent",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.1,
      unit: "%",
      description:
        "Chance a human reviewer denies the request once Approval Latency elapses. Fails with reason 'human_denied_approval' — a distinct, honest signal from a guardrail rejection or a tool failure: a human looked at this and said no.",
      impact:
        "Raise it to model a stricter reviewer, or traffic that's genuinely more likely to warrant denial. 0 means the gate is pure latency with no real check behind it.",
      benchmark: {
        low: 0,
        avg: 0.1,
        high: 0.4,
        lowNote: "a routine, low-risk action — almost always approved",
        avgNote: "a typical irreversible-action review",
        highNote: "a high-risk action under close scrutiny — denied often",
      },
    },
    {
      key: "maxConcurrent",
      label: "Max Concurrent",
      shortLabel: "max",
      type: "number",
      min: 1,
      max: 100,
      step: 1,
      default: 5,
      description:
        "Approvals this node can be actively reviewing at once — a human reviewer's own bounded capacity. Raise it to model more reviewers staffed at once; lower it to model a single on-call reviewer as a real bottleneck.",
      impact: "Raise it to admit more concurrent reviews before anything queues.",
      benchmark: {
        low: 1,
        avg: 5,
        high: 20,
        lowNote: "a single on-call reviewer",
        avgNote: "a small review team",
        highNote: "a large, well-staffed review queue",
      },
    },
    {
      key: "maxQueueLength",
      label: "Max Queue Length",
      shortLabel: "queue",
      type: "number",
      min: 0,
      max: 200,
      step: 1,
      default: 30,
      description: "Approvals allowed to wait once Max Concurrent is reached, before being rejected outright.",
      impact: "Raise it to absorb a burst of approval requests without rejecting any, at the cost of a growing backlog.",
      benchmark: {
        low: 0,
        avg: 30,
        high: 100,
        lowNote: "fail-fast — reject overflow immediately",
        avgNote: "absorbs a normal burst",
        highNote: "deep buffering for a bursty caller",
      },
    },
  ],
};
