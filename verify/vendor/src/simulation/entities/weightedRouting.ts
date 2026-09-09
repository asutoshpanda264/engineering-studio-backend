/**
 * Expands a list of positive integer weights into a repeated-index
 * sequence, so a plain round-robin cursor cycling over that sequence
 * dispatches to each index in proportion to its weight over any full
 * cycle — e.g. weights [3, 1] -> sequence [0, 0, 0, 1].
 *
 * Originally lived only in LoadBalancer.ts (`weightedSequenceFor`, for
 * Weighted Round Robin). CDN's proximity-weighted edge routing needs the
 * identical property — the closer an edge is to the placed User, the
 * larger its share of dispatches — so this is extracted once a second
 * real use case needed it (per ENTITIES.md: don't introduce an
 * abstraction before two use cases require it).
 *
 * Callers are responsible for producing valid, already-rounded, already-
 * capped positive integers — this function only does the expansion, since
 * "what counts as a valid weight" differs by caller (LoadBalancer treats
 * an unconfigured target as weight 1; CDN derives weight from distance).
 */
export function buildWeightedSequence(weights: number[]): number[] {
  const sequence: number[] = [];
  weights.forEach((weight, index) => {
    for (let i = 0; i < weight; i++) sequence.push(index);
  });
  return sequence;
}
