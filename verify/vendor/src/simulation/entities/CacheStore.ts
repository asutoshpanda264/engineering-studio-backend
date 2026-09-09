/**
 * A single keyed store with capacity-bound eviction — the state and
 * eviction-policy logic one Cache owns, and what a CDN owns one of per
 * edge (each edge is a geographically distributed copy of the same
 * idea). Extracted here once CDN needed the exact same LRU/LFU/FIFO/MRU
 * logic Cache already had, rather than duplicating it.
 */

export type EvictionPolicy = "lru" | "lfu" | "fifo" | "mru";

export interface CacheStoreConfig {
  capacity: number;
  evictionPolicy: EvictionPolicy;
  /** How long an entry stays valid after being stored, in ms. 0 = never expires. */
  ttlMs: number;
}

interface CacheEntry {
  insertedAt: number;
  lastAccessedAt: number;
  accessCount: number;
  /** This entry's own effective TTL, in ms — usually `config.ttlMs`, but
   * `set`'s optional override lets a caller jitter an individual entry's
   * TTL (see Cache.ts's ttlJitterPercent) without changing every other
   * entry's. 0 = never expires. */
  ttlMs: number;
}

/** `lookup`'s outcome: "hit" (present, valid), "cold" (never cached, or
 * evicted for capacity), or "expired" (was cached, but its own TTL has
 * since passed) — cold and expired are both misses, but only expired
 * feeds Cache's Avalanche accounting (CacheStore has no capacity-eviction
 * event of its own, so an evicted entry surfaces as "cold" here, same as
 * a key that was simply never seen before). */
export type CacheLookupResult = "hit" | "cold" | "expired";

export class CacheStore {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(private readonly config: CacheStoreConfig) {}

  /** Distinct entries currently stored — used by Cache.ts's semantic caching mode to scale hit likelihood with how "full" the store is, not just an exact key match. */
  get size(): number {
    return this.entries.size;
  }

  /** Whether `key` is present and not expired — see CacheLookupResult.
   * Expired entries are evicted as a side effect of being looked up. */
  lookup(key: string, now: number): CacheLookupResult {
    const entry = this.entries.get(key);
    if (!entry) return "cold";
    if (entry.ttlMs > 0 && now - entry.insertedAt >= entry.ttlMs) {
      this.entries.delete(key);
      return "expired";
    }
    return "hit";
  }

  /** Records an access to an already-present key (recency/frequency bookkeeping). */
  touch(key: string, now: number): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.lastAccessedAt = now;
    entry.accessCount++;
  }

  /** Stores `key`, evicting one entry first if at capacity. `ttlMsOverride`
   * lets this one entry's expiry diverge from `config.ttlMs` — used for
   * TTL jitter; omit it to use the store's configured TTL as before. */
  set(key: string, now: number, ttlMsOverride?: number): void {
    if (!this.entries.has(key) && this.entries.size >= this.config.capacity) {
      this.evictOne();
    }
    this.entries.set(key, {
      insertedAt: now,
      lastAccessedAt: now,
      accessCount: 1,
      ttlMs: ttlMsOverride ?? this.config.ttlMs,
    });
  }

  private evictOne(): void {
    let victimKey: string | null = null;
    let victimEntry: CacheEntry | null = null;

    for (const [key, entry] of this.entries) {
      if (!victimEntry || this.isMoreEvictable(entry, victimEntry)) {
        victimKey = key;
        victimEntry = entry;
      }
    }
    if (victimKey !== null) this.entries.delete(victimKey);
  }

  private isMoreEvictable(candidate: CacheEntry, current: CacheEntry): boolean {
    switch (this.config.evictionPolicy) {
      case "fifo":
        return candidate.insertedAt < current.insertedAt;
      case "lru":
        return candidate.lastAccessedAt < current.lastAccessedAt;
      case "mru":
        return candidate.lastAccessedAt > current.lastAccessedAt;
      case "lfu":
        if (candidate.accessCount !== current.accessCount) {
          return candidate.accessCount < current.accessCount;
        }
        // Tie-break deterministically rather than leaving eviction order
        // to Map iteration happenstance.
        return candidate.insertedAt < current.insertedAt;
    }
  }
}
