/**
 * Min-heap priority queue for simulation events.
 *
 * Events are ordered by timestamp. When two events share the same
 * timestamp, the one enqueued first is processed first (stable ordering).
 *
 * Why a heap instead of a sorted array?
 * - enqueue: O(log n) — heap insert
 * - dequeue: O(log n) — heap extract-min
 *
 * A sorted array would give O(n) inserts and waste time re-sorting
 * after every dequeue. The heap is the right tool for an event loop
 * that processes events one at a time.
 *
 * From: SIMULATION-ENGINE.md §8 — The Simulation Loop
 * "Take the next event. Advance virtual time. Deliver the event."
 *
 * This class has zero React dependencies.
 */

import type { SimulationEvent as Event } from "../events/types";

type HeapNode = {
  event: Event;
  sequence: number; // monotonic counter for stable tie-breaking
};

export class EventQueue {
  private heap: HeapNode[] = [];
  private sequenceCounter = 0;

  /** Number of events currently in the queue. */
  get size(): number {
    return this.heap.length;
  }

  /** Whether any events remain to be processed. */
  hasEvents(): boolean {
    return this.heap.length > 0;
  }

  /** Peek at the next event without removing it. Returns null if empty. */
  peek(): Event | null {
    if (this.heap.length === 0) return null;
    return this.heap[0].event;
  }

  /**
   * Insert an event into the queue.
   * O(log n).
   */
  enqueue(event: Event): void {
    const node: HeapNode = {
      event,
      sequence: this.sequenceCounter++,
    };
    this.heap.push(node);
    this.bubbleUp(this.heap.length - 1);
  }

  /**
   * Remove and return the event with the smallest timestamp.
   * O(log n). Throws if the queue is empty.
   */
  dequeue(): Event {
    if (this.heap.length === 0) {
      throw new Error("Cannot dequeue from an empty event queue");
    }

    const root = this.heap[0];
    const last = this.heap.pop()!;

    if (this.heap.length > 0) {
      this.heap[0] = last;
      this.sinkDown(0);
    }

    return root.event;
  }

  /** Remove all events (used between simulation runs). */
  clear(): void {
    this.heap = [];
    this.sequenceCounter = 0;
  }

  /** Return all events sorted by timestamp (without modifying the queue). */
  toArray(): Event[] {
    return [...this.heap]
      .sort((a, b) => {
        if (a.event.timestamp !== b.event.timestamp) {
          return a.event.timestamp - b.event.timestamp;
        }
        return a.sequence - b.sequence;
      })
      .map((n) => n.event);
  }

  // ---- Heap internals ----

  private bubbleUp(index: number): void {
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);
      if (this.compare(this.heap[index], this.heap[parentIndex]) < 0) {
        [this.heap[index], this.heap[parentIndex]] = [
          this.heap[parentIndex],
          this.heap[index],
        ];
        index = parentIndex;
      } else {
        break;
      }
    }
  }

  private sinkDown(index: number): void {
    const n = this.heap.length;
    while (true) {
      let smallest = index;
      const left = 2 * index + 1;
      const right = 2 * index + 2;

      if (left < n && this.compare(this.heap[left], this.heap[smallest]) < 0) {
        smallest = left;
      }
      if (right < n && this.compare(this.heap[right], this.heap[smallest]) < 0) {
        smallest = right;
      }

      if (smallest !== index) {
        [this.heap[index], this.heap[smallest]] = [
          this.heap[smallest],
          this.heap[index],
        ];
        index = smallest;
      } else {
        break;
      }
    }
  }

  /**
   * Compare two heap nodes. Orders by timestamp first, then by
   * insertion sequence for stable ordering on ties.
   */
  private compare(a: HeapNode, b: HeapNode): number {
    if (a.event.timestamp !== b.event.timestamp) {
      return a.event.timestamp - b.event.timestamp;
    }
    return a.sequence - b.sequence;
  }
}
