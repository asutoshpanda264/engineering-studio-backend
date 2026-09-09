/**
 * Turns a scenario's TrafficPattern into concrete request arrival
 * timestamps. Pulled out from Simulator as its own pure function — it has
 * nothing to do with event dispatch, and is easy to test in isolation
 * ("a constant rate produces roughly rate*seconds arrivals").
 *
 * Zero React dependencies.
 */

import type { RNG } from "./RNG";
import type { Timestamp, TrafficPattern } from "../types";

export function generateArrivalTimestamps(
  pattern: TrafficPattern,
  durationMs: number,
  rng: RNG
): Timestamp[] {
  switch (pattern.type) {
    case "constant":
      return generateConstant(pattern.rate, durationMs, rng);
    case "burst":
      return generateBurst(pattern, durationMs, rng);
    case "ramp":
      return generateRamp(pattern, durationMs, rng);
  }
}

/**
 * Picks which resource (of `poolSize` possible ones) a request is for.
 * Not true Zipfian sampling — that needs a precomputed CDF over the pool
 * — but squaring a uniform draw is a well-known cheap way to get the same
 * qualitative shape: a small set of "hot" keys dominate, most keys are
 * rare. That skew is what makes a Cache's hit rate meaningful at all; a
 * uniform draw would make every key equally rare and no cache would help.
 */
export function assignRequestKey(rng: RNG, poolSize: number): string {
  if (poolSize <= 1) return "key_0";
  const index = Math.floor(poolSize * rng.next() ** 2);
  return `key_${Math.min(index, poolSize - 1)}`;
}

/** Bounds on the phantom (permanently nonexistent) key pool derived from
 * `phantomKeyPoolSize` — small enough that phantom keys repeat often (the
 * shape a negative cache can actually protect against), but scaling a
 * little with the real key pool so a much larger architecture still gets
 * more than a couple of distinct "missing" ids. */
const PHANTOM_KEY_POOL_MIN = 2;
const PHANTOM_KEY_POOL_MAX = 20;
const PHANTOM_KEY_POOL_FRACTION = 0.1;

/** How many distinct nonexistent keys `assignPhantomKey` draws from, given
 * the Client's normal Key Pool Size. Exported so Cache's tests and any UI
 * that wants to explain the phantom pool's size can derive the same number
 * instead of hardcoding a second copy of this formula. */
export function phantomKeyPoolSize(keyPoolSize: number): number {
  return Math.min(
    PHANTOM_KEY_POOL_MAX,
    Math.max(PHANTOM_KEY_POOL_MIN, Math.round(keyPoolSize * PHANTOM_KEY_POOL_FRACTION))
  );
}

/**
 * Decides, once per request, whether it targets a resource that will never
 * exist — cache penetration traffic (see RequestLifecycleMetadata.exists).
 * Deliberately skips drawing from `rng` at all when `missingKeyRate` is 0
 * (the default): every existing scenario/test that never sets a Client's
 * Missing Key Rate keeps drawing the exact same RNG sequence it always has
 * for `assignRequestKey`/`assignRequestRoute`, so this is purely additive.
 */
export function assignRequestExistence(rng: RNG, missingKeyRate: number): boolean {
  if (missingKeyRate <= 0) return true;
  return rng.next() >= missingKeyRate;
}

/**
 * Picks which of a small, fixed pool of permanently nonexistent keys a
 * "missing" request targets — uniformly, not skewed like assignRequestKey:
 * an attacker enumerating ids, or a client repeatedly hitting a typo'd or
 * deleted one, has no reason to favor any one phantom id over another. The
 * `missing_` prefix keeps this namespace disjoint from assignRequestKey's
 * `key_` namespace by construction, so a phantom id can never accidentally
 * collide with a real one.
 */
export function assignPhantomKey(rng: RNG, keyPoolSize: number): string {
  const poolSize = phantomKeyPoolSize(keyPoolSize);
  const index = Math.floor(rng.next() * poolSize);
  return `missing_${Math.min(index, poolSize - 1)}`;
}

/**
 * Decides, once per request, whether it needs multi-hop relationship
 * reasoning to answer correctly rather than a single similarity-matched
 * chunk — see RequestLifecycleMetadata.requiresRelationshipTraversal, and
 * Retriever.ts's GraphRAG mode, which specifically wins on this traffic.
 * Same "skip the RNG draw entirely at rate 0" purely-additive shape as
 * assignRequestExistence, for the identical reason: every existing
 * scenario/test that never sets a Client's Relationship Query Rate keeps
 * drawing the exact same RNG sequence it always has.
 */
export function assignRequestRelationshipQuery(
  rng: RNG,
  relationshipQueryRate: number
): boolean {
  if (relationshipQueryRate <= 0) return false;
  return rng.next() < relationshipQueryRate;
}

/**
 * Fixed pool of realistic-looking service paths a Reverse Proxy can route
 * between. Not free-text/configurable — a small closed set keeps the
 * Reverse Proxy's routing rules a dropdown (no typo-prone string matching
 * against a client's own config) and keeps this deterministic across runs.
 */
export const ROUTE_LABELS = [
  "/orders",
  "/users",
  "/payments",
  "/search",
  "/checkout",
  "/notifications",
  "/inventory",
  "/reviews",
] as const;

/**
 * Picks which named service (of the first `poolSize` entries in
 * ROUTE_LABELS) a request is addressed to. Uniform, unlike
 * assignRequestKey's skew — routes aren't "hot vs. cold" the way cache
 * keys are, they're just realistically distinct destinations a Reverse
 * Proxy needs to be able to tell apart.
 */
export function assignRequestRoute(rng: RNG, poolSize: number): string {
  const size = Math.max(1, Math.min(poolSize, ROUTE_LABELS.length));
  const index = Math.floor(rng.next() * size);
  return ROUTE_LABELS[Math.min(index, size - 1)];
}

/** Poisson arrivals: inter-arrival gaps drawn from an exponential distribution. */
function generateConstant(
  ratePerSecond: number,
  durationMs: number,
  rng: RNG
): Timestamp[] {
  if (ratePerSecond <= 0) return [];
  const lambdaPerMs = ratePerSecond / 1000;

  const timestamps: Timestamp[] = [];
  let t = 0;
  while (true) {
    t += rng.nextExponential(lambdaPerMs);
    if (t >= durationMs) break;
    timestamps.push(Math.round(t));
  }
  return timestamps;
}

/** `rate` arrivals spread across each `duration`-ms window, repeating every `interval` ms. */
function generateBurst(
  pattern: { rate: number; interval: number; duration: number },
  durationMs: number,
  rng: RNG
): Timestamp[] {
  const timestamps: Timestamp[] = [];

  for (
    let windowStart = 0;
    windowStart < durationMs;
    windowStart += pattern.interval
  ) {
    const windowEnd = Math.min(windowStart + pattern.duration, durationMs);
    for (let i = 0; i < pattern.rate; i++) {
      const t = windowStart + rng.nextFloat(0, windowEnd - windowStart);
      if (t < durationMs) timestamps.push(Math.round(t));
    }
  }

  return timestamps.sort((a, b) => a - b);
}

/** Rate interpolates linearly from startRate to endRate, approximated in small buckets. */
function generateRamp(
  pattern: { startRate: number; endRate: number; duration: number },
  durationMs: number,
  rng: RNG
): Timestamp[] {
  const bucketMs = 100;
  const timestamps: Timestamp[] = [];
  const effectiveDuration = Math.min(pattern.duration, durationMs);

  for (
    let bucketStart = 0;
    bucketStart < effectiveDuration;
    bucketStart += bucketMs
  ) {
    const progress = bucketStart / pattern.duration;
    const rate =
      pattern.startRate + (pattern.endRate - pattern.startRate) * progress;
    const expectedInBucket = (rate * bucketMs) / 1000;

    const wholeCount = Math.floor(expectedInBucket);
    const fractional = expectedInBucket - wholeCount;
    const count = wholeCount + (rng.next() < fractional ? 1 : 0);

    for (let i = 0; i < count; i++) {
      const t = bucketStart + rng.nextFloat(0, bucketMs);
      if (t < durationMs) timestamps.push(Math.round(t));
    }
  }

  return timestamps.sort((a, b) => a - b);
}
