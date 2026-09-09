/**
 * Virtual clock for the simulation engine.
 *
 * Time is virtual — it advances only when events require it.
 * The clock never queries wall-clock time.
 *
 * From: SIMULATION-ENGINE.md §5 — "Time Does Not Flow"
 * The simulation never asks "What time is it?"
 * It asks "What is the timestamp of the next event?"
 *
 * This class has zero React dependencies.
 */

import type { Timestamp } from "../types";

export class Clock {
  private _time: Timestamp = 0;

  /** Current virtual time in milliseconds. */
  now(): Timestamp {
    return this._time;
  }

  /** Set the clock to a specific timestamp. */
  setTime(timestamp: Timestamp): void {
    if (timestamp < this._time) {
      throw new Error(
        `Clock can only move forward: tried to set time to ${timestamp}, but current time is ${this._time}`
      );
    }
    this._time = timestamp;
  }

  /** Advance the clock to the timestamp of the next event. */
  advanceTo(timestamp: Timestamp): void {
    if (timestamp < this._time) {
      throw new Error(
        `Clock can only move forward: tried to advance to ${timestamp}, but current time is ${this._time}`
      );
    }
    this._time = timestamp;
  }

  /** Jump forward by a delta (useful for generating periodic events). */
  advanceBy(deltaMs: Timestamp): void {
    this._time += deltaMs;
  }

  /** Reset the clock to zero (used between simulation runs). */
  reset(): void {
    this._time = 0;
  }
}
