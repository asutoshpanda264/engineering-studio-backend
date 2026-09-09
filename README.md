# Engineering Studio — Backend

The backend for [Engineering Studio](../engineering_studio) (a distributed-systems learning sandbox) — two services, one repo:

- **`api/`** — Spring Boot. Users, roles, scenarios, attempts, points, progress, leaderboards, daily challenges.
- **`verify/`** — Node/Express. Re-runs the frontend's own simulation engine server-side, so a submitted architecture's score is computed by the server, never trusted from the client.

Combined into one repo deliberately, not a technical requirement — see `masterdoc/decisions.md`'s entry on the monorepo restructure for the reasoning.

**Start here:** [`masterdoc/README.md`](masterdoc/README.md) — the full documentation index: what's built, why every notable decision was made, and how each piece actually works, organized phase by phase.

## Quick start

```sh
# api/ — needs Docker running (Testcontainers-backed integration tests)
cd api && ./mvnw test

# verify/
cd verify && npm install && npm run sync-vendor && npm test
```
# engineering-studio-backend
