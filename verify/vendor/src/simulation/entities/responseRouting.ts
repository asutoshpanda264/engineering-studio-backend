/**
 * Finds who a "response" direction hop should go to next, and whether
 * that recipient is the terminal client.
 *
 * `path` records forward-leg hops, but not uniformly: an entity appends
 * itself only if it goes on to forward the request further. An entity
 * that answers straight from local state — a cache hit, or any future
 * entity that can short-circuit — never appends itself, since there's
 * nothing "after" it to reach. So an entity's own predecessor is either
 * the element just before its own position in `path` (if it's in
 * there — it forwarded onward at some point) or simply the last element
 * (if it's not — it's answering directly, so whoever sent it the
 * request is exactly the last recorded hop).
 *
 * Every entity that can sit between the Client and a terminal responder
 * (APIServer, Database, LoadBalancer, Cache, ...) must route its
 * response-direction traffic through this — skipping it means anything
 * upstream of that entity never sees the response, which silently
 * breaks any entity that needs to observe responses (a Cache needs to
 * see them to know what to store).
 */

import type { EntityId } from "../types";

export interface ResponseTarget {
  target: EntityId;
  isClient: boolean;
}

export function findResponseTarget(
  selfId: EntityId,
  path: EntityId[]
): ResponseTarget {
  const selfIndex = path.indexOf(selfId);
  const target =
    selfIndex === -1 ? path[path.length - 1] : path[Math.max(0, selfIndex - 1)];
  return { target, isClient: target === path[0] };
}
