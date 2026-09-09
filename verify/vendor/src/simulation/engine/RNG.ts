/**
 * Deterministic random number generator (seeded).
 *
 * Instead of querying the operating system for randomness,
 * the simulation creates a repeatable sequence from a seed.
 *
 * From: SIMULATION-ENGINE.md §9 — "Randomness Still Exists"
 *
 * Same seed → same sequence every time.
 * Different seeds → different worlds.
 *
 * This class has zero React dependencies.
 */

export class RNG {
  private seed: number;
  private state: number;

  constructor(seed: number) {
    this.seed = seed;
    this.state = seed;
  }

  /** Returns the original seed used to initialize this RNG. */
  getSeed(): number {
    return this.seed;
  }

  /**
   * Generate the next pseudo-random number in [0, 1).
   * Uses a simple but reliable LCG (Linear Congruential Generator).
   */
  next(): number {
    // These constants are from Numerical Recipes — proven and deterministic.
    this.state = (this.state * 1664525 + 1013904223) & 0xffffffff;
    return (this.state & 0x7fffffff) / 0x7fffffff;
  }

  /** Generate a random integer in [min, max). */
  nextInt(min: number, max: number): number {
    return Math.floor(this.next() * (max - min)) + min;
  }

  /** Generate a random float in [min, max). */
  nextFloat(min: number, max: number): number {
    return this.next() * (max - min) + min;
  }

  /**
   * Generate a random value from an exponential distribution.
   * Useful for inter-arrival times in Poisson processes.
   * @param lambda — rate parameter (events per unit time)
   */
  nextExponential(lambda: number): number {
    // Inverse transform sampling: -ln(1-U) / λ
    // Guard against U === 0 (which would give infinity).
    const u = Math.max(this.next(), 1e-10);
    return -Math.log(1 - u) / lambda;
  }

  /**
   * Generate a random value from a normal distribution
   * using the Box-Muller transform.
   */
  nextNormal(mean = 0, stdDev = 1): number {
    const u1 = Math.max(this.next(), 1e-10);
    const u2 = Math.max(this.next(), 1e-10);
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return z * stdDev + mean;
  }
}
