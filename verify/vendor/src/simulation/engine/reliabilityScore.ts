/**
 * `docs/Agentic_AI.md` §2.5's pass^k reliability score — this pillar's one
 * genuinely novel contribution, not just a translation of an existing idea
 * into this engine. τ-bench's headline metric, pass^k, asks: does an agent
 * solve the *same* task on *every one* of k tries — reliability, not one
 * lucky run. Because this engine is already seeded/deterministic
 * (SIMULATION-ENGINE.md §9), that question is directly, honestly
 * answerable here: re-run the identical architecture across N different
 * seeds and report the fraction that reach a successful terminal state.
 *
 * "Successful terminal state" is a threshold on the run's own successRate
 * rather than "every single request succeeded" — this engine's traffic
 * model is many concurrent requests per run, not one discrete task
 * execution the way a τ-bench episode is, so pass^k's literal "solved or
 * not" binary is reinterpreted as "did this run clear the bar," with the
 * bar itself a parameter the caller sets (a scenario's own success-rate
 * gate, when one exists, or a sensible default otherwise) rather than
 * something this module asserts on the architecture's behalf.
 *
 * Reuses `runSimulation` directly — the same "re-run and compare" shape
 * `compareArchitectures.ts` already established for "with vs. without one
 * entity," just varying the seed instead of the topology. Zero React
 * dependencies, same as everything else under `simulation/`.
 */

import { runSimulation } from "./Simulator";
import type { SimulationConfig } from "../types";

export interface ReliabilityScoreOptions {
  /** How many seeds to sample. Default 10 — enough to distinguish "flaky" from "reliable" without the re-run itself taking long (each run is well under 100ms). */
  seeds?: number;
  /** The successRate a run must clear to count as a "pass." Default 0.95 — a deliberately generic bar; pass a scenario's own gate for a scenario-specific reading. */
  successRateThreshold?: number;
}

export interface ReliabilityScoreResult {
  seeds: number;
  passingSeeds: number;
  /** passingSeeds / seeds — the pass^k score itself, 0-1. */
  passRate: number;
  successRateThreshold: number;
  /** This run's own successRate for each sampled seed, in seed order — the raw evidence behind passRate, same "show the evidence, don't just assert it" spirit as compareArchitectures.ts's own comparison output. */
  perSeedSuccessRates: number[];
}

/** Exported so callers (the UI's "Run Check (N seeds)" label) can display the real default instead of a duplicated magic number. */
export const DEFAULT_SEEDS = 10;
const DEFAULT_SUCCESS_RATE_THRESHOLD = 0.95;

/**
 * Re-runs `config` across `options.seeds` consecutive seeds starting from
 * `config.options.seed` (so the result is itself reproducible — calling
 * this twice on the same config yields the same seed sequence and
 * therefore the same score) and reports the pass^k-style reliability
 * score. Each run is fully independent — no shared state between seeds —
 * so this is a straightforward, honest re-run, not an estimate.
 */
export function computeReliabilityScore(
  config: SimulationConfig,
  options: ReliabilityScoreOptions = {}
): ReliabilityScoreResult {
  const seeds = options.seeds ?? DEFAULT_SEEDS;
  const successRateThreshold = options.successRateThreshold ?? DEFAULT_SUCCESS_RATE_THRESHOLD;
  const baseSeed = config.options.seed;

  const perSeedSuccessRates: number[] = [];
  for (let i = 0; i < seeds; i++) {
    const seededConfig: SimulationConfig = {
      ...config,
      options: { ...config.options, seed: baseSeed + i },
    };
    const result = runSimulation(seededConfig);
    perSeedSuccessRates.push(result.metrics.successRate);
  }

  const passingSeeds = perSeedSuccessRates.filter(
    (rate) => rate >= successRateThreshold
  ).length;

  return {
    seeds,
    passingSeeds,
    passRate: seeds > 0 ? passingSeeds / seeds : 0,
    successRateThreshold,
    perSeedSuccessRates,
  };
}
