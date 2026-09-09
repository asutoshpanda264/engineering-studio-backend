/**
 * Shared concurrency/queue bookkeeping for any entity that does bounded
 * capacity work (APIServer, Database, ...). Composed by those entities
 * rather than inherited — it's the "how many things can I do at once,
 * and what happens to the rest" logic they'd otherwise duplicate.
 *
 * This class only tracks admission decisions. It does not know about
 * simulated time or events — the owning entity is responsible for
 * scheduling the PROCESSING_COMPLETED wake-up and calling `complete()`
 * when it fires.
 *
 * Zero React dependencies.
 */

import type { SimulationEvent } from "../events/types";

export type AdmissionResult = "started" | "queued" | "rejected";

export class BoundedProcessor {
  private activeCount = 0;
  private queue: SimulationEvent[] = [];

  constructor(
    private readonly maxConcurrent: number,
    private readonly maxQueueLength: number
  ) {}

  get activeRequests(): number {
    return this.activeCount;
  }

  get queueLength(): number {
    return this.queue.length;
  }

  /** Called when new work arrives. */
  admit(triggeringEvent: SimulationEvent): AdmissionResult {
    if (this.activeCount < this.maxConcurrent) {
      this.activeCount++;
      return "started";
    }
    if (this.queue.length < this.maxQueueLength) {
      this.queue.push(triggeringEvent);
      return "queued";
    }
    return "rejected";
  }

  /**
   * Called when one unit of work finishes. Returns the next queued
   * request to begin, if the backlog wasn't empty.
   */
  complete(): SimulationEvent | null {
    this.activeCount--;
    const next = this.queue.shift();
    if (!next) return null;
    this.activeCount++;
    return next;
  }
}
