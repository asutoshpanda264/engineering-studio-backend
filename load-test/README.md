# Load test

`scenarios.js` — a [k6](https://k6.io) script covering the flows that matter most under real concurrent load: register+login, attempt start/submit (the heaviest path — it round-trips through `verify/`'s own simulation run), and the two most-read public endpoints (leaderboard, daily challenge).

## Run it

```sh
# Bring up the real stack first
docker compose up --build

# From this directory:
k6 run scenarios.js                          # full run — ramps to 500 concurrent VUs over ~9 minutes
SMOKE=1 k6 run scenarios.js                   # ~10s, 2 VUs — sanity-check the script itself before a full run
API_BASE_URL=http://localhost:8080 k6 run scenarios.js   # against a non-default host
```

Thresholds (`options.thresholds` in the script): error rate under 1%, p95 request duration under 800ms. A run that breaches either exits non-zero — this is meant to be a pass/fail gate, not just numbers to eyeball.

## Install k6

No package manager entry needed — it's a single static binary:

```sh
curl -sL https://github.com/grafana/k6/releases/download/v0.55.0/k6-v0.55.0-linux-amd64.tar.gz | tar xz
mv k6-v0.55.0-linux-amd64/k6 ~/.local/bin/k6   # or anywhere on PATH
```
