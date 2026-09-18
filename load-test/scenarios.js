// k6 load test — Sept 18 nav plan, Phase D.
//
// Exercises the flows that matter most under real concurrent load: login,
// attempt start/submit (the heaviest path — it round-trips through
// verify/'s own simulation run), and the two most-read public endpoints
// (leaderboard, daily challenge). Each virtual user registers a fresh
// throwaway account rather than sharing one set of credentials — closer to
// real traffic (many distinct users), and sidesteps needing pre-seeded
// fixtures just to run this.
//
// Usage:
//   SMOKE=1 k6 run scenarios.js                 # ~10s, 2 VUs — sanity-check the script itself
//   k6 run scenarios.js                          # full run: ramps to 500 VUs over ~9 minutes
//   API_BASE_URL=http://localhost:8080 k6 run scenarios.js   # against a non-default host
//
// Needs the real stack up first: `docker compose up` from the repo root
// (or `./mvnw spring-boot:test-run` in api/ + `npm run dev` in verify/ +
// Postgres/Redis running some other way).

import http from "k6/http";
import { check, sleep } from "k6";
import { Rate } from "k6/metrics";

const BASE_URL = __ENV.API_BASE_URL || "http://localhost:8080";
const SMOKE = __ENV.SMOKE === "1";

// A real seeded scenario (V2.1__seed_scenarios.sql) — its own starting
// graph is reused verbatim as the submit payload below, so every submit is
// a genuinely valid ClientGraph, not a synthetic one that might not match
// what verify/ actually expects.
const SCENARIO_ID = "internal-admin-dashboard";
const STARTING_GRAPH = {
  nodes: [
    { id: "client", type: "client", position: { x: 80, y: 200 }, config: { requestRate: 350 } },
    { id: "api", type: "api", position: { x: 400, y: 200 }, config: {} },
    { id: "db", type: "database", position: { x: 720, y: 200 }, config: {} },
  ],
  connections: [
    { source: "client", target: "api" },
    { source: "api", target: "db" },
  ],
};

const errorRate = new Rate("errors");

export const options = {
  scenarios: {
    main: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: SMOKE
        ? [{ duration: "10s", target: 2 }]
        : [
            { duration: "1m", target: 100 },
            { duration: "2m", target: 300 },
            { duration: "2m", target: 500 },
            { duration: "3m", target: 500 },
            { duration: "1m", target: 0 },
          ],
      gracefulRampDown: "30s",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<800"],
    errors: ["rate<0.01"],
  },
};

function jsonHeaders(accessToken) {
  const headers = { "Content-Type": "application/json" };
  if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;
  return { headers };
}

export default function () {
  const email = `loadtest-${__VU}-${__ITER}-${Date.now()}@example.com`;

  const registerRes = http.post(
    `${BASE_URL}/auth/register`,
    JSON.stringify({ email, password: "loadtest12345", displayName: "Load Test" }),
    jsonHeaders()
  );
  errorRate.add(!check(registerRes, { "register -> 201": (r) => r.status === 201 }));

  const loginRes = http.post(
    `${BASE_URL}/auth/login`,
    JSON.stringify({ email, password: "loadtest12345" }),
    jsonHeaders()
  );
  const loggedIn = check(loginRes, { "login -> 200": (r) => r.status === 200 });
  errorRate.add(!loggedIn);
  if (!loggedIn) {
    sleep(1);
    return;
  }
  const accessToken = loginRes.json("accessToken");

  const leaderboardRes = http.get(`${BASE_URL}/leaderboards/best-solved?limit=20`);
  errorRate.add(!check(leaderboardRes, { "leaderboard -> 200": (r) => r.status === 200 }));

  const dailyChallengeRes = http.get(`${BASE_URL}/daily-challenge/today`);
  errorRate.add(!check(dailyChallengeRes, { "daily challenge -> 200": (r) => r.status === 200 }));

  const startRes = http.post(
    `${BASE_URL}/attempts`,
    JSON.stringify({ scenarioId: SCENARIO_ID, mode: "TIMED" }),
    jsonHeaders(accessToken)
  );
  const started = check(startRes, { "attempt start -> 201": (r) => r.status === 201 });
  errorRate.add(!started);

  if (started) {
    const attemptId = startRes.json("id");
    const submitRes = http.post(
      `${BASE_URL}/attempts/${attemptId}/submit`,
      JSON.stringify({ graph: STARTING_GRAPH }),
      jsonHeaders(accessToken)
    );
    // A 200 is success whether or not the submitted graph actually clears
    // the scenario's own success criteria — verify/ genuinely ran the
    // simulation and returned a real score either way, which is what this
    // load test cares about (the endpoint's behavior under load), not
    // whether this specific throwaway graph "solves" the scenario.
    errorRate.add(!check(submitRes, { "attempt submit -> 200": (r) => r.status === 200 }));
  }

  sleep(1);
}
