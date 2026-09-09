/**
 * Replays an already-computed SimulationResult on a controllable timeline —
 * play / pause / seek / speed — without touching the simulation itself.
 *
 * From: SIMULATION-ENGINE.md §11 — "Playback Is Not Simulation"
 * The simulation computes; playback only decides which slice of that
 * immutable history is currently visible. Content at any given timestamp
 * is therefore fully deterministic regardless of how playback got there —
 * scrubbing to T and playing to T produce identical events and metrics.
 * Metrics are derived by re-running the same `collectMetrics` the engine
 * itself uses (ADR-005 — metrics are derived, never invented twice).
 *
 * requestAnimationFrame is injected via PlaybackScheduler rather than
 * called directly, so this file has zero browser dependencies of its own
 * and stays unit-testable the same way Clock/EventQueue/RNG are.
 */

import { collectMetrics } from "../metrics/MetricsCollector";
import type { SimulationEvent } from "../events/types";
import type {
  EntityId,
  MetricsSnapshot,
  SimulationResult,
  Timestamp,
} from "../types";

export interface PlaybackState {
  readonly currentTime: Timestamp;
  readonly duration: Timestamp;
  readonly speed: number;
  readonly playing: boolean;
}

export type PlaybackListener = (
  state: PlaybackState,
  metrics: MetricsSnapshot,
  visibleEvents: SimulationEvent[]
) => void;

/** Everything PlaybackController needs from a frame-scheduling host. */
export interface PlaybackScheduler {
  requestFrame(callback: (nowMs: number) => void): number;
  cancelFrame(handle: number): void;
}

const MIN_SPEED = 0.5;
const MAX_SPEED = 4;

export function createBrowserScheduler(): PlaybackScheduler {
  return {
    requestFrame: (cb) => requestAnimationFrame(cb),
    cancelFrame: (handle) => cancelAnimationFrame(handle),
  };
}

export class PlaybackController {
  private readonly result: SimulationResult;
  private readonly entityIds: EntityId[];
  private readonly scheduler: PlaybackScheduler;

  private currentTime: Timestamp = 0;
  private speed = 1;
  private playing = false;

  private frameHandle: number | null = null;
  /** Wall-clock time of the last tick, used to derive real frame deltas. */
  private lastFrameTime: number | null = null;

  private readonly listeners = new Set<PlaybackListener>();

  constructor(
    result: SimulationResult,
    scheduler: PlaybackScheduler = createBrowserScheduler()
  ) {
    this.result = result;
    this.entityIds = Object.keys(result.metrics.entityMetrics);
    this.scheduler = scheduler;
  }

  getState(): PlaybackState {
    return {
      currentTime: this.currentTime,
      duration: this.result.duration,
      speed: this.speed,
      playing: this.playing,
    };
  }

  /** Events with timestamp <= current playback time, in chronological order. */
  getVisibleEvents(): SimulationEvent[] {
    return eventsUpTo(this.result.events, this.currentTime);
  }

  /**
   * Metrics as of the current playback time — recomputed from the visible
   * slice each call. This re-derives rather than caches; for very long
   * event logs this could be optimized to accumulate incrementally, but
   * that hasn't been measured as necessary yet (IMPLEMENTATION.md —
   * "Measure before optimizing").
   */
  getMetrics(): MetricsSnapshot {
    return collectMetrics(
      this.getVisibleEvents(),
      this.entityIds,
      this.currentTime,
      this.result.clientIds,
      this.result.agentOrchestratorIds,
      this.result.guardrailValidatorIds
    );
  }

  /** Starts (or resumes) playback. Replays from the beginning if already at the end. */
  play(): void {
    if (this.playing) return;
    if (this.currentTime >= this.result.duration) {
      this.currentTime = 0;
    }
    this.playing = true;
    this.lastFrameTime = null;
    this.scheduleNextFrame();
    this.notify();
  }

  pause(): void {
    if (!this.playing) return;
    this.playing = false;
    this.cancelScheduledFrame();
    this.notify();
  }

  /** Jumps to a specific point in the timeline. Clamped to [0, duration]. */
  seek(timestamp: Timestamp): void {
    this.currentTime = clamp(timestamp, 0, this.result.duration);
    this.notify();
  }

  /** Playback speed multiplier, clamped to [0.5x, 4x] per WORKSHOP-UI.md. */
  setSpeed(multiplier: number): void {
    this.speed = clamp(multiplier, MIN_SPEED, MAX_SPEED);
    this.notify();
  }

  restart(): void {
    this.currentTime = 0;
    this.notify();
  }

  /** Returns an unsubscribe function. */
  subscribe(listener: PlaybackListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Stops any in-flight frame and drops all listeners. Call on unmount. */
  dispose(): void {
    this.cancelScheduledFrame();
    this.listeners.clear();
  }

  // ---- internals ----

  private scheduleNextFrame(): void {
    this.frameHandle = this.scheduler.requestFrame((nowMs) => this.tick(nowMs));
  }

  private cancelScheduledFrame(): void {
    if (this.frameHandle !== null) {
      this.scheduler.cancelFrame(this.frameHandle);
      this.frameHandle = null;
    }
  }

  private tick(nowMs: number): void {
    if (!this.playing) return;

    // First tick after play()/resume establishes the baseline rather than
    // advancing by a possibly-huge delta since the last unrelated frame.
    const realDeltaMs =
      this.lastFrameTime === null ? 0 : nowMs - this.lastFrameTime;
    this.lastFrameTime = nowMs;

    this.currentTime = clamp(
      this.currentTime + realDeltaMs * this.speed,
      0,
      this.result.duration
    );

    if (this.currentTime >= this.result.duration) {
      this.playing = false;
      this.cancelScheduledFrame();
      this.notify();
      return;
    }

    this.notify();
    this.scheduleNextFrame();
  }

  private notify(): void {
    const state = this.getState();
    const metrics = this.getMetrics();
    const visibleEvents = this.getVisibleEvents();
    this.listeners.forEach((listener) => listener(state, metrics, visibleEvents));
  }
}

/**
 * Binary search for the cutoff instead of a linear scan, since this runs
 * on every playback frame. Relies on events being timestamp-sorted
 * (non-decreasing), which the Simulator guarantees by construction.
 */
function eventsUpTo(
  events: SimulationEvent[],
  time: Timestamp
): SimulationEvent[] {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (events[mid].timestamp <= time) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return events.slice(0, lo);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
