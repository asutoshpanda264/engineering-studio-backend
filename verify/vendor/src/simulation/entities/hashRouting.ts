/**
 * Deterministic string -> bucket hashing (FNV-1a mod bucket count), shared
 * by any entity that needs the same input to consistently land on the
 * same target rather than being spread randomly.
 *
 * Originally lived only in CDN.ts (key -> edge, mirroring anycast/geo-DNS
 * keeping a given user's requests hitting the same nearby edge).
 * LoadBalancer's IP Hash algorithm needs the identical property — the
 * same client consistently lands on the same server, for session affinity
 * — so this is extracted once a second real use case needed it (per
 * ENTITIES.md: don't introduce an abstraction before two use cases
 * require it).
 */
export function hashStringToIndex(value: string, bucketCount: number): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return Math.abs(hash) % bucketCount;
}
