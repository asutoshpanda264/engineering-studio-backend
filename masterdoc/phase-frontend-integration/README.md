# Frontend Integration — connecting `engineering_studio` to this backend

**Status:** ✅ Increments 1-5 done, verified live. Not one of the numbered 1-9 milestones from the
approved build plan (`/home/asutosh/.claude/plans/lets-dicuss-more-what-zany-swing.md`)
— a separate initiative, started once Phases 1-8 gave the frontend a real
API surface to connect to. Milestone 9 (AI assistant seam) is explicitly
deferred until this is done.

## What this is

`engineering_studio` (the frontend — a sibling repo, `../engineering_studio`,
**not** part of this repo) has been a fully static, local-only Next.js app
since its own inception — no backend, no accounts, `localStorage`-only
progress. That was a deliberate, documented product pivot (see the
frontend's own Claude Code memory:
`project_product_pivot_backend`/`feedback_backend_learn_by_building`) —
Phases 1-8 here built the backend side of that pivot. This phase is the
other half: actually wiring the frontend to it.

**Guest usage stays fully intact throughout** — nobody is forced to sign
in. A signed-in session is additive: the same free-play, instant-local-scoring
experience keeps working exactly as before for anyone who doesn't log in.

## Increments (this phase's own sub-units — see decisions.md for each)

- **Increment 1 — Auth foundation** ✅ done. API client, token storage,
  reactive auth store, `/login`+`/register` pages, a header auth-status
  widget, CORS on the backend (previously missing entirely).
- **Increment 2 — Attempt/submit flow** ✅ done. The Workshop's "Timed
  Challenge" feature now creates a real backend `Attempt` on start and
  submits the built graph to `POST /attempts/{id}/submit` on the first
  passing run — a real, server-verified score (the actual verify-service,
  not the client's own `scoreScenario` call) is what counts toward
  points/streaks/leaderboards. Free-play/NO_PRESSURE mode stays
  local-only for now — a deliberate scope boundary, see decisions.md #7.
- **Increment 3 — Leaderboard + Daily Challenge pages** ✅ done. Two new
  pages, `/leaderboard` and `/daily-challenge`, reading the Phase 6/7
  endpoints that had no frontend UI at all until now. No new attempt-flow
  wiring needed — the Daily Challenge "Solve it" CTA reuses Increment 2's
  existing Timed Challenge deep-link (`/workshop?scenario=<id>&timed=1`),
  and `DailyChallengeService.onScenarioSolved` (Phase 7) already
  auto-credits a completion for any TIMED solve of today's scenario,
  whichever page it was launched from. See decisions.md #13.
- **Increment 4 — Workshop header signed-in indicator** ✅ done. A new
  compact `WorkshopAuthStatus` widget closes decisions.md #11's
  previously-deferred gap — icon-first at every width, matching the
  existing Tutorial/Problems/Learn collapse pattern, so it fits the
  header's already-tight zero-breakpoint layout. See decisions.md #17.
- **Increment 5 — NO_PRESSURE/free-play backend wiring** ✅ done. Free
  play now creates a real backend `Attempt` (mode `NO_PRESSURE`) as soon
  as a scenario loads, submits it on the first passing run, and
  immediately opens a fresh one so a later, better run can submit again
  — no session boundary, unlike Timed Challenge's bounded shape. Also
  fixed a real, pre-existing race condition (found during this
  increment's live verification, affecting Timed Challenge too, not
  introduced by this increment) where a hard page load could silently
  skip creating any backend attempt at all for a genuinely signed-in
  student. See decisions.md #18-20.
- **Not yet done:** a progress-history page beyond the daily-challenge
  history list built in Increment 3.

## Files touched

### Backend (`engineering-studio-backend/api/`)
- `src/main/java/.../config/CorsProperties.java` (new), `SecurityConfig.java`
  (CORS wired into the filter chain) — Increment 1
- `src/test/java/.../TestcontainersConfiguration.java` — a real bug fix
  (Redis `@ServiceConnection` needed an explicit `name`), caught the first
  time `spring-boot:test-run` was actually exercised — Increment 1

### Frontend (`engineering_studio/`)
- `src/lib/api/client.ts`, `types.ts` (new) — typed HTTP client + DTOs
  mirroring the backend's real response shapes (Increment 1); attempt
  types + `ClientGraph`/`ClientEntity`/`ClientConnection` added to
  `types.ts` (Increment 2)
- `src/lib/auth/tokens.ts`, `authStore.ts` (new) — token storage + the
  reactive `useAuth()` store (refresh-on-401, login/register/logout) —
  Increment 1; `refreshUser()` + `getCurrentUser()` added — Increment 2
- `src/app/login/page.tsx`, `src/app/register/page.tsx` (new) — Increment 1
- `src/components/auth/AuthStatus.tsx` (new) — wired into
  `src/app/problems/page.tsx`'s header — Increment 1
- `src/components/auth/AuthBootstrap.tsx` (new) — mounted in
  `src/app/layout.tsx`; a real bug fix, Increment 2 (see decisions.md #10)
- `src/lib/api/attempts.ts` (new) — `startAttempt`/`submitAttempt` —
  Increment 2
- `src/lib/workshopSubmission.ts` (new) — canvas → `ClientGraph`
  conversion — Increment 2
- `src/store/workshopStore.ts` (edited) — `backendAttemptId`/
  `backendAttemptStatus` state, `submitBackendAttempt()`,
  `startTimedChallenge()`/`clearTimedChallenge()` extended — Increment 2
- `src/components/workshop/ScenarioCompletionToast.tsx` (edited) — calls
  `submitBackendAttempt()` alongside the existing local `recordSolved` —
  Increment 2
- `src/app/layout.tsx` (edited) — mounts `AuthBootstrap` — Increment 2
- `docs/CLAUDE.md` (edited) — corrected the stale "no backend, no auth"
  claim per the pivot memory's own instruction to update it once this
  work landed — Increment 1
- `.env.local` (new, untracked — `.gitignore`'s `.env*` rule) —
  `NEXT_PUBLIC_API_BASE_URL`
- `types.ts` (extended) — `LeaderboardType`, `LeaderboardEntryResponse`,
  `MyLeaderboardStandingResponse`, `DailyChallengeAssignedBy`,
  `DailyChallengeResponse`, `MyDailyChallengeStandingResponse`,
  `DailyChallengeCompletionResponse` — Increment 3
- `src/lib/api/leaderboards.ts` (new) — `getLeaderboard(type, limit?)`,
  `getMyLeaderboardStanding(type)` — Increment 3
- `src/lib/api/dailyChallenge.ts` (new) — `getTodayChallenge()`,
  `getChallengeForDate(date)`, `getMyDailyChallengeStanding()`,
  `getDailyChallengeHistory()` — Increment 3
- `src/app/leaderboard/page.tsx` (new) — 3-tab (best/most/fastest solved)
  ranked table + a "your rank" card for signed-in users — Increment 3
- `src/app/daily-challenge/page.tsx` (new) — today's pick, a "Solve it"
  CTA (or a "Completed today" badge), a streak card, and a completion
  history list, all gated the same guest-vs-signed-in way as leaderboard
  — Increment 3
- `src/app/problems/page.tsx` (edited) — added "Leaderboard" and "Daily"
  links to the `AppHeader` right slot, same responsive
  icon+`sm:inline-flex` pattern as the existing "Interviews" link —
  Increment 3
- `src/components/workshop/WorkshopAuthStatus.tsx` (new) — compact,
  icon-first auth indicator for the Workshop's own header — Increment 4
- `src/components/workshop/WorkshopHeader.tsx` (edited) — mounts
  `WorkshopAuthStatus` between `ThemeToggle` and the Export/Settings
  group — Increment 4
- `src/store/workshopStore.ts` (extended) — new state
  `freePlayAttemptId`/`freePlayAttemptStatus`; new `startFreePlayAttempt(scenarioId)`
  action; `loadScenario()` calls it; `startTimedChallenge()` clears it;
  `clearTimedChallenge()` restarts it; `submitBackendAttempt()` now
  branches on `timedModeStartedAt` to handle both TIMED (unchanged) and
  free play — Increment 5
- `src/app/workshop/page.tsx` (edited) — `ScenarioDeepLink` now waits for
  `useAuth().status` to settle before loading a scenario/starting a
  challenge — a real race-condition fix, not just free-play wiring; see
  decisions.md #19 — Increment 5

## Docs in this folder

- `decisions.md` — one numbered entry per real decision/finding, grouped
  by increment.
- `explain_frontend_integration.md` — how the two apps actually talk to
  each other: the request path, the auth store's shape, the
  guest-vs-signed-in split.

## Test status

- Frontend: `tsc --noEmit`, `npx eslint`, and the full existing Vitest
  suite (1537/1537) all still pass after BOTH increments — no
  regressions, checked after each.
- Increment 1, verified live: the real three-service stack (`api/` on
  :8080 via `spring-boot:test-run`'s real Testcontainers Postgres+Redis,
  `verify/` on :4000, `engineering_studio` on :3000) — register →
  auto-login → header updates → logout → header reverts, driven through
  the actual browser UI via `claude-in-chrome`, not just curl.
- Increment 2, verified live end-to-end: Timed Challenge start → real
  `POST /attempts` (201) → build (via the scenario's own reference
  solution, to avoid driving React Flow drag-and-drop through browser
  automation) → Run Simulation → real `POST /attempts/{id}/submit` (200)
  → real `GET /me` refresh — all captured as actual network requests, not
  inferred. Confirmed against the backend directly afterward: a genuinely
  `SOLVED` `problem_progress` row with real verify-service-computed
  stars/points/composite/speedFactor, and the same result showing up on
  the real Redis-backed leaderboard.
- Two real bugs found this way, not by static checks (see decisions.md
  #5 and #10) — both would have shipped silently broken without an
  actual live run.
- Increment 3, verified live: registered a fresh test account through
  the real UI, confirmed `GET /leaderboards/{type}` (200) and
  `GET /daily-challenge/today` (200) firing from both pages as a guest
  and signed in, confirmed the signed-in "not ranked yet"/"0-day streak"
  states render correctly for a brand-new account, and confirmed the
  Daily Challenge page's "Solve it" CTA produces exactly
  `/workshop?scenario=price-alert-notifications&timed=1` (today's actual
  assigned scenario) and correctly lands in a locked, running Timed
  Challenge session. No console errors, no failed requests, across both
  pages in both auth states.
- Increment 4, verified live: reused the still-signed-in Increment 3 test
  account to confirm the new Workshop header indicator renders the real
  display name (`GET /me` 200 on Workshop load, no new bootstrap wiring
  needed — `AuthBootstrap` already runs everywhere), and that clicking
  its "Sign out" button logs out live, reverting the header to a "Sign
  In" link without a reload. No console errors.
- Increment 5, verified live: a hard-loaded free-play `/workshop` URL
  produced real `POST /attempts` (201) → `POST /attempts/{id}/submit`
  (200) → a fresh `POST /attempts` (201) on the very next passing run —
  three genuinely distinct attempt ids confirmed from the raw request
  URLs. `GET /leaderboards/best-solved`/`most-solved` (curl) both stayed
  empty, confirming NO_PRESSURE correctly never ranks. A real
  pre-existing race condition (a hard page load could silently skip
  creating any backend attempt, for BOTH free play and Timed Challenge)
  was found and fixed during this same pass — reproduced before the fix,
  confirmed gone after it, on the identical hard-navigation test. Guest
  behavior (signed out, same URL) still fired zero `/attempts` calls. No
  console errors throughout.
