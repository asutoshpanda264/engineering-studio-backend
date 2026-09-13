# decisions.md — Frontend Integration

Decisions specific to connecting `engineering_studio` (frontend) to this
backend. Grouped by increment. Project-wide backend decisions live in
`masterdoc/decisions.md`; this file is the one place decisions spanning
BOTH repos get recorded, since neither repo's own doc system covers that
on its own.

---

## Increment 1 — Auth foundation

### 1. Guests keep the exact current experience — a signed-in session is additive, not a requirement

- **Chose:** anonymous/guest usage of the Workshop (local simulation,
  local instant scoring via `scoreScenario`, `localStorage`-based progress
  via `@/lib/problemProgress` and its siblings) is untouched. Signing in
  only ADDS a parallel, server-tracked path — it doesn't replace or gate
  the existing one.
- **Why:** this backend's own `SecurityConfig` requires a valid JWT for
  `POST /attempts` (starting ANY tracked attempt, including NO_PRESSURE
  mode) — meaning a naive "just wire it all through the backend" approach
  would have forced every Workshop visitor to create an account before
  building anything, a real regression from the app's current
  "blank playground, no login wall" identity (`docs/CLAUDE.md` §2's own
  design principle #9: "the Workshop opens as a blank playground"). The
  chosen split mirrors exactly how LeetCode itself works — solve freely
  with no account, create one specifically to have a solve count/rank —
  which is also the exact analogy the original product-pivot decision
  used to justify the backend's existence in the first place (see the
  frontend's own `project_product_pivot_backend` memory).
- **Scenario it covers:** Increment 2's design (not yet built) — the
  Workshop's submit flow branches on `useAuth().user` being present, not
  on a hard redirect-to-login.

### 2. `useSyncExternalStore` + a plain module, not Zustand or a Context provider

- **Chose:** `src/lib/auth/authStore.ts` — a module-level cache +
  listener `Set` + `useSyncExternalStore`, the SAME shape
  `@/components/theme/ThemeProvider.tsx` and `@/lib/problemProgress.ts`
  already use. `useAuth()` is a plain hook, callable from anywhere with no
  wrapping `<AuthProvider>` needed.
- **Considered:** Zustand (already a real dependency, used for
  `workshopStore.ts`); a React Context provider (matching `ThemeProvider`'s
  own shape, which DOES use Context).
- **Why this instead:** `problemProgress.ts`'s own header comment already
  states this codebase's preference explicitly — matching an established
  precedent over introducing Zustand's `persist` middleware for a single
  cross-cutting feature. Not Context either: nothing about auth state
  needs the "many deeply-nested consumers, expensive to prop-drill"
  shape Context solves for `ThemeProvider` (theme affects nearly every
  styled element); auth is read by a handful of call sites
  (`AuthStatus`, the login/register pages, and — Increment 2 — the
  Workshop's submit flow), each of which can just call `useAuth()`
  directly.

### 3. Reactive-refresh-on-401 lives in ONE place (`authenticatedRequest`), not duplicated per caller

- **Chose:** `authStore.ts` exports `authenticatedRequest<T>(path, options)`
  — attaches the current access token, and on a single 401 tries exactly
  one `/auth/refresh` before retrying once. Every other authenticated call
  site (today: the `/me` bootstrap and login-flow; Increment 2: the
  attempt/submit calls) goes through this, never re-implementing its own
  retry.
- **Why exactly one retry, not a loop:** a second 401 after a successful
  refresh means the REFRESH token itself is invalid (revoked, expired) —
  retrying again would either loop forever or mask a genuine "you're
  logged out" state as a hang.

### 4. CORS: explicit allow-list, no credentials, `Authorization`+`Content-Type` only

- **Chose:** `config.CorsProperties` (`app.cors.allowed-origins`, default
  `http://localhost:3000`) + a `CorsConfigurationSource` bean registered
  via `.cors(...)` in `SecurityConfig`. `allowCredentials` stays `false`.
- **Why no credentials:** the JWT travels in the `Authorization` header
  (set by `authenticatedRequest` from a token read out of `localStorage`),
  never a cookie — there's no credentialed (cookie/session) cross-origin
  request this API needs to support, so leaving `allowCredentials` off is
  correct, not just a missed setting.
- **A real gap, not a design choice:** no CORS configuration existed on
  this backend at all before this increment — every one of Phases 1-8's
  tests went through MockMvc (same-process, no real browser, no CORS
  concept) or curl, so this was never exercised until an actual browser
  tried to call the API cross-origin. Caught immediately (every fetch
  silently failing) the moment real integration testing started.

### 5. Two real bugs, both caught by actually running the connected stack — not assumed away

- **`TestcontainersConfiguration`'s Redis bean, never exercised until
  now:** `redisContainer()` (added Phase 6) uses `@ServiceConnection`
  with no `name` — works fine on `AbstractIntegrationTest`'s `@Container`
  FIELD (JUnit-extension-based discovery), but `./mvnw spring-boot:test-run`
  (the `@Bean`-method-based discovery path, used for the FIRST time this
  session to actually run the app locally against a real browser) failed
  with `ConnectionDetailsNotFoundException: ... You may need to add a
  'name' to your @ServiceConnection annotation`. Fixed exactly as the
  exception named — `@ServiceConnection(name = "redis")`. Every Phase 6-8
  test run went through the JUnit suite exclusively, so this had been
  sitting latent, undiscovered, since Phase 6.
- **`authStore.ts`'s `getServerSnapshot` returning a fresh object literal
  every call:** broke `useSyncExternalStore`'s referential-stability
  requirement — React warned live, in the real browser console ("The
  result of getServerSnapshot should be cached to avoid an infinite
  loop"), the first time the login page was actually rendered. Fixed with
  a module-level `IDLE_STATE` constant — the exact fix
  `@/lib/problemProgress.ts`'s own `EMPTY_PROGRESS` constant already
  applies for the identical reason; should have been followed from the
  start rather than rediscovered.
- **Scenario both cover:** the general lesson — `tsc`/lint/the existing
  Vitest suite all passed cleanly through both of these; neither would
  have been caught without actually running the real, connected stack in
  a real browser. Confirms why Increment 1 (and Increment 2) get a live
  `claude-in-chrome` verification pass, not just static checks.

### 6. `docs/CLAUDE.md`'s stale "no backend, no auth" claim, corrected now

- **Chose:** updated §4's "Explicitly deferred" list and §5's tech-stack
  Storage row — auth/backend/leaderboards are no longer deferred, with a
  pointer to the pivot memory and to this masterdoc phase, and an
  explicit note that guest/local-only usage remains fully intact.
- **Why now, not later:** the frontend's own `project_product_pivot_backend`
  memory explicitly says these docs "should be updated to reflect this
  once the backend work lands" — that's now true, so leaving the doc
  stale any longer would actively mislead a future session (or a human
  reader) into treating "no backend" as still-current guidance.

---

## Increment 2 — Attempt/submit flow

### 7. TIMED mode maps onto the EXISTING "Timed Challenge" feature — not every "Run Simulation" click

- **Chose:** a backend `Attempt` is only ever created/submitted when the
  frontend's own Timed Challenge is active (`workshopStore.ts`'s
  `timedModeStartedAt`) — `startTimedChallenge()` now also fires
  `POST /attempts` (mode `TIMED`); the first genuinely new passing run
  while that attempt is open submits it.
- **Considered:** submitting to the backend on EVERY passing
  `runSimulation()` click, timed or not.
- **Why this instead:** the backend's attempt model assumes a bounded
  "start once, submit once" shape — `elapsedSeconds` is computed
  server-side as `submittedAt - startedAt`, and a SECOND submit on the
  same attempt id 409s ("already submitted"). The frontend's free-play
  loop is the opposite shape on purpose (iterate and re-run as many times
  as you want, no bounded window) — mapping THAT onto one-shot attempts
  would mean either silently discarding most runs or constantly starting
  throwaway attempts with meaningless (near-zero) elapsed times. Timed
  Challenge already has real "start" and "this one run is the graded one"
  semantics that match the backend's model exactly — a difficulty-scaled
  countdown the frontend already computes
  (`timeLimitMinutesFor`/`DEFAULT_TIME_LIMIT_MINUTES`) using the SAME
  10/15/20/25/30-minute-by-difficulty table as the backend's own
  `PointsCalculator.defaultTimeLimitSeconds` — independently arrived at,
  a good sign these two mental models were always meant to line up.
- **Explicitly out of scope for this increment:** NO_PRESSURE/free-play
  mode wiring. A scenario load outside Timed Challenge stays exactly
  local-only (no backend attempt at all) — a real, deliberate scope
  boundary, not an oversight. A future increment would need its own
  "start on load, submit on first pass, but allow re-submitting a BETTER
  later attempt" design, genuinely different from Timed Challenge's
  bounded shape.

### 8. Only the FIRST passing run per Timed Challenge submits — not every one after it

- **Chose:** once `submitBackendAttempt()` succeeds, `backendAttemptId`
  is cleared — a later, even-better passing run in the SAME challenge
  session does not try to submit again (the attempt is already terminal
  on the backend; it would just 409).
- **Why:** matches how a real timed exercise normally works — graded on
  your first successful submission within the window, not silently
  re-graded on every subsequent tweak. Getting a genuinely NEW graded
  attempt requires starting a new Timed Challenge (a fresh `startedAt`,
  a fresh `POST /attempts`) — exactly what the Restart button already
  does when re-entering timed mode.
- **Known, accepted edge case:** if the passing run's OWN toast fires
  before `startAttempt()`'s response has come back (`backendAttemptId`
  still `null`), that run is silently NOT submitted — no queueing/retry
  logic exists for this. In practice this needs a student to pass within
  roughly one HTTP round-trip of clicking "Start Timed Challenge," which
  is not a realistic build time. Documented here rather than engineered
  around, matching this project's general practice for low-probability
  edge cases (see e.g. `phase-7-daily-challenge-streaks/decisions.md` #7).

### 9. `submitBackendAttempt` submits regardless of the LOCAL "beat the clock" flag

- **Chose:** the backend submit fires on ANY genuinely-new passing result
  while a `backendAttemptId` is open — not gated on
  `ScenarioCompletionToast.tsx`'s own `underTime` boolean (wall-clock time
  since `timedModeStartedAt`, compared against `timeLimitMsFor`).
- **Why:** the backend's OWN scoring already accounts for speed —
  `elapsedSeconds` feeds `PointsCalculator.speedFactor` continuously (a
  slower finish scores worse, not "disqualified"), so there's no
  "missed the deadline" concept to enforce on the frontend's side. Gating
  on `underTime` would just silently drop legitimate, real attempts that
  finished a little slow, for no actual backend reason to reject them.

### 10. A real bug, caught by the first live end-to-end attempt: the auth store never bootstraps on pages that don't render a `useAuth()` caller

- **What happened:** `startTimedChallenge()`'s `getCurrentUser()` check
  returned `null` on `/workshop` even with valid tokens sitting in
  `localStorage` and a confirmed-active session (verified moments earlier
  on `/problems`) — no `POST /attempts` call ever fired.
- **Why:** `authStore.ts`'s `bootstrap()` — the function that actually
  reads `localStorage` and calls `/me` — only ever runs from
  `useAuth()`'s own `useEffect`. Before this fix, the ONLY component
  calling `useAuth()` anywhere in the app was `AuthStatus`, itself wired
  into exactly one page (`/problems`). A session landing directly on
  `/workshop` — the actual page this whole increment is about — never
  triggered bootstrap AT ALL, so `getCurrentUser()` stayed `null` for the
  entire visit regardless of how genuinely signed-in the user was.
- **The fix:** `src/components/auth/AuthBootstrap.tsx` — a tiny
  render-nothing component whose only job is calling `useAuth()`, mounted
  once in the root layout (`src/app/layout.tsx`, alongside
  `ThemeProvider`/`LockInGuard`) so bootstrap runs on every page load,
  not just the ones that happen to render `AuthStatus`.
- **Scenario it covers:** verified directly — network requests captured
  via `claude-in-chrome` showed `GET /me` returning 200 immediately on a
  fresh `/workshop` load (previously nothing), followed by a real
  `POST /attempts` (201) once Timed Challenge started. Never would have
  been caught by `tsc`/lint/Vitest — a hook simply never firing produces
  no error, just silently missing behavior. The general lesson: a
  cross-cutting client-state concern (auth, theme, ...) needs a
  guaranteed-mounted-everywhere trigger, not "whichever page happens to
  use it first."

### 11. `AuthStatus` deliberately NOT added to the Workshop's own header — in Increment 2

- **Chose (at the time):** left `WorkshopHeader.tsx` untouched — a
  signed-in Workshop session had no visible confirmation of that fact
  on-canvas (only `/problems`'s header showed it).
- **Why deferred, not just forgotten:** that header's own code comment
  states it already needed "~1335px with zero breakpoints to avoid
  overflowing" — every existing action already collapses to icon-only
  below `xl`. Squeezing `AuthStatus` (email + streak + logout, sized for
  a normal `AppHeader`) into an already fully-packed, carefully-tuned bar
  under time pressure risked a real regression to a working layout for a
  polish item, not a functional gap — Increment 2's actual attempt/submit
  wiring was verified working end-to-end (real network requests, a real
  scored `problem_progress` row, a real leaderboard entry) without it.
  Worth a small follow-up, not worth rushing here.
- **Done in Increment 4** — see #17: a purpose-built compact widget, not
  `AuthStatus` itself, resolved the width concern rather than accepting
  it as permanent.

### 12. Verified live end-to-end, not just compiled — a real solved row and leaderboard entry

- Drove the actual flow through `claude-in-chrome` against the real
  three-service stack: `/workshop?scenario=...&timed=1` → loaded the
  scenario's own reference solution (`loadOptimalSolution()`, no manual
  canvas building needed for verification purposes) → Run Simulation →
  local toast fires → captured network requests confirmed
  `POST /attempts` (201) then `POST /attempts/{id}/submit` (200) then a
  follow-up `GET /me` (the `refreshUser()` call).
- Confirmed against the backend directly (curl, not just the UI):
  `GET /progress/scenarios/internal-admin-dashboard` showed a real,
  server-computed `status: SOLVED`, `bestStars: 2`, `bestPoints: 16`,
  real `bestComposite`/`bestSpeedFactor` — genuinely computed by the
  verify-service from the submitted graph, not anything the client
  claimed. `GET /leaderboards/best-solved` showed the same user, same
  score, rank 1 — Phase 6's whole ZSET pipeline reachable end-to-end from
  a real browser for the first time.
- `currentStreak: 0` on `/me` — correctly NOT incremented, since
  "Internal Admin Dashboard" wasn't the day's designated daily challenge
  (Phase 7 streaks are keyed to that specifically, not "solved
  something") — confirms the two systems' actual designs agree, not a
  bug.

---

## Increment 3 — Leaderboard + Daily Challenge pages

### 13. Daily Challenge's "Solve it" CTA reuses Increment 2's Timed Challenge deep-link — no new attempt-flow wiring

- **Chose:** the CTA is a plain `LinkButton` to
  `/workshop?scenario={challenge.scenarioId}&timed=1` — the exact URL
  shape `ScenarioDeepLink` (`src/app/workshop/page.tsx`) already reads to
  auto-start a Timed Challenge attempt.
- **Why no new backend call or frontend wiring was needed:**
  `DailyChallengeService.onScenarioSolved` (Phase 7,
  `phase-7-daily-challenge-streaks/explain_dailychallenge.md`) already
  listens for the same `ScenarioSolvedEvent` a TIMED submit fires
  regardless of entry point, and auto-detects whether the solved
  scenario matches today's `DailyChallenge` row — crediting a completion
  and advancing the streak with zero awareness of "which frontend page
  the student came from." The daily-challenge page's only job is
  launching a real Timed Challenge for the right scenario; Phase 7's own
  event listener does the actual crediting, exactly as it was designed
  to for any TIMED solve however reached (Workshop's own scenario picker
  included).
- **Considered:** a dedicated "start today's challenge" endpoint or
  frontend action. Rejected as unnecessary duplication — the deep-link
  already IS that action.

### 14. Guest-visible, auth-gated-extra — same split as Increment 1's design principle, applied to two new pages

- **Chose:** both `GET /leaderboards/{type}` and
  `GET /daily-challenge/today` are public (no `Authorization` header
  sent), so `/leaderboard` and `/daily-challenge` render fully for a
  guest — only the "your rank" card, the streak card, and the completion
  history additionally fetch `GET /leaderboards/{type}/me` and
  `GET /daily-challenge/today/me`/`/history` when `useAuth().user` is
  present.
- **Why:** the same "signed-in is additive, not a gate" principle
  decision #1 established for the Workshop itself — a leaderboard a
  guest can't even look at, or a daily challenge hidden behind a login
  wall, would be a real regression from "browse everything, sign in only
  to have your own solves counted."

### 15. Fetch state keyed by what it answers, not reset with a synchronous `setState` in the effect body

- **Chose:** both pages' data-fetching effects never call `setState`
  synchronously in the effect body (only from inside a resolved/rejected
  promise callback) — instead, each piece of fetched state carries the
  `LeaderboardType`/request key it answers (e.g.
  `{ type: LeaderboardType; kind: "ok" | "error"; entries? }`), and the
  render compares that tag against the currently-selected tab to decide
  whether to show a loading state, rather than clearing state to `null`
  up front.
- **Why:** `eslint-plugin-react-hooks`'s `set-state-in-effect` rule (this
  codebase's lint config, `npm run lint`) flags a synchronous reset —
  clearing then repopulating state on every dependency change is exactly
  the "cascading renders" pattern it exists to catch. Tagging the result
  with the key it belongs to gets the same "don't show stale data for
  the wrong tab" behavior without ever needing that synchronous reset.

### 16. Verified live: a fresh signed-in account, both pages, both auth states, no console/network errors

- Registered a brand-new test account through the real register flow
  (not curl/fixtures), then drove `/leaderboard` and `/daily-challenge`
  as both a guest and that signed-in account via `claude-in-chrome`.
- Confirmed via `read_network_requests`: `GET /leaderboards/fastest-solved`
  (200) firing on tab switch, `GET /daily-challenge/today` (200) on load,
  both returning real data (today's actual assigned scenario, "Price
  Alert Notifications," difficulty 2/5).
- Confirmed the signed-in empty states render correctly for a genuinely
  new account: "You don't have a ranked, timed solve on Best Solved
  yet," "Current streak: 0 days," "No completions yet."
- Confirmed the "Solve it" CTA's actual rendered `href` (via `read_page`)
  matched the expected deep-link exactly, and clicking it landed in a
  real, locked, running Timed Challenge session with a real
  `POST /attempts` (201) already fired.
- `read_console_messages` showed zero errors across the whole pass.

---

## Increment 4 — Workshop header signed-in indicator

### 17. A purpose-built compact widget (`WorkshopAuthStatus`), not the full `AuthStatus`, closes decisions.md #11's gap

- **Chose:** `src/components/workshop/WorkshopAuthStatus.tsx` — icon-first
  at every width, matching the treatment `WorkshopHeader.tsx` already
  gives Tutorial/Problems/Learn/Clear/Reset (icon + `hidden xl:inline`
  label). Guest: a single "Sign In" icon-link. Signed in: a streak badge
  (only shown when `currentStreak > 0`, and only at `xl`+), a user
  icon + truncated display name (name only at `xl`+), and a
  ghost-variant "Sign out" icon button — three elements total, reusing
  the existing `Button` `ghost`/`sm` treatment already used for
  Export/Settings in the same row.
- **Why not just drop `AuthStatus` in as-is:** unchanged from #11's
  reasoning — `AuthStatus` renders a "Sign in / Create account" link
  pair for guests, or streak+full-name+logout with no responsive
  collapse at all, sized for a normal `AppHeader` that isn't already at
  ~1335px with zero breakpoints. A purpose-built widget that collapses
  the same way every other item in this row already does was the actual
  fix, not "make more room somehow."
- **Placement:** between `ThemeToggle` and the Export/Settings group,
  each side bounded by the same `h-5 w-px bg-border` divider already
  used elsewhere in this row — groups the auth indicator with the other
  global-nav items (Tutorial/Problems/Learn/ThemeToggle), not with the
  canvas-specific actions (Export/Settings/Clear/Reset/Run).
- **Verified live:** loaded `/workshop` in the same browser session as
  the still-signed-in Increment 3 test account — confirmed `GET /me`
  (200) firing and the truncated display name rendering in the header
  with no code change needed to `AuthBootstrap` (it already runs on
  every page, Increment 2 decisions.md #10). Clicked the new "Sign out"
  button — logged out correctly, header reverted to the "Sign In" link
  live, no reload needed. No console errors.

---

## Increment 5 — NO_PRESSURE/free-play backend wiring

### 18. Free play attempts follow decisions.md #7's own anticipated shape: start on load, submit on first pass, open a fresh one on every subsequent success

- **Chose:** `workshopStore.ts` gained `freePlayAttemptId`/
  `freePlayAttemptStatus`, a deliberately SEPARATE pair from
  `backendAttemptId`/`backendAttemptStatus` (TIMED's), plus a new
  `startFreePlayAttempt(scenarioId)` action. `loadScenario()` calls it
  immediately (a no-op for guests, same shape as `startTimedChallenge`).
  `submitBackendAttempt()` (the same function `ScenarioCompletionToast`
  already called for Timed Challenge) now branches on
  `timedModeStartedAt`: inside a Timed Challenge, unchanged Increment-2
  behavior; otherwise, submits `freePlayAttemptId` and — on success —
  immediately calls `startFreePlayAttempt` again for the SAME scenario,
  rather than going terminal.
- **Why immediately re-arm instead of leaving it submitted:** a
  NO_PRESSURE attempt is exactly as one-shot on the backend as TIMED
  (`AttemptService.submit` rejects a second submit on any attempt whose
  status is already `SUBMITTED`, regardless of mode) — but free play
  itself has no session boundary the way a Timed Challenge countdown
  does. "Allow re-submitting a better later attempt," this file's own
  anticipated design from Increment 2, means literally that: every
  passing run (`ScenarioCompletionToast`'s existing "genuinely new
  simulationResult" trigger — unchanged, reused as-is) submits into
  whatever free-play attempt is currently open, and a fresh one is ready
  immediately after, with no re-load and no visible gap for the student.
- **Entering/exiting Timed Challenge abandons/resumes free play
  cleanly:** `startTimedChallenge()` now also clears
  `freePlayAttemptId`/`freePlayAttemptStatus` (the two modes are
  mutually exclusive at any given moment — `submitBackendAttempt`
  branches on `timedModeStartedAt` alone, so a stale free-play id here
  would just be inert dead state while timed mode is active, never
  acted on). `clearTimedChallenge()` — not currently reachable from any
  UI, but kept consistent in case it ever is — calls
  `startFreePlayAttempt` again on exit so a return to free play isn't
  left untracked until the next full scenario reload.
- **Real backend behavior this relies on, already built and tested in
  earlier phases, not new here:** `ProblemProgressService.recordOutcome`
  (Phase 5) already marks a scenario genuinely `SOLVED`
  server-side for a NO_PRESSURE submit — contributing zero points and
  never touching `best_*`/leaderboards — and still publishes
  `ScenarioSolvedEvent` unconditionally on mode, which
  `DailyChallengeService` (Phase 7) already listens for. Practically:
  solving TODAY's daily-challenge scenario in free play now also credits
  the completion and keeps the streak alive, exactly like a TIMED solve
  does — with zero new backend code, purely as a consequence of finally
  wiring the frontend's free-play path into the same event.

### 19. A real, pre-existing race condition found and fixed during this increment's live verification — not introduced by it

- **What happened:** live-testing free play via a genuine hard page load
  (`navigate()` to a fresh `/workshop?scenario=...` URL, not an in-app
  `<Link>` click) showed NO `POST /attempts` firing at all, despite a
  valid signed-in session. Re-testing the SAME way against
  `?scenario=...&timed=1` (Timed Challenge, Increment 2's existing,
  already-shipped code) reproduced the identical silent failure —
  confirming this was a latent bug in the EXISTING code, not something
  Increment 5 introduced.
- **Root cause:** `ScenarioDeepLink` (`src/app/workshop/page.tsx`) and
  `AuthBootstrap` both fire their mount effects in the same React
  commit. `AuthBootstrap`'s effect kicks off `bootstrap()`'s real
  `GET /me` network round-trip, but doesn't (can't) block anything —
  `ScenarioDeepLink`'s effect calls `loadScenario`/`startTimedChallenge`/
  `startFreePlayAttempt` synchronously in that same tick, and each of
  those reads `getCurrentUser()` as a point-in-time snapshot. On a
  genuine hard page load (a bookmarked/shared link, or a plain browser
  refresh), that snapshot is ALWAYS still `null` — no synchronous
  localStorage-based user hydration exists in `authStore.ts`, only the
  real async fetch — so the check always lost this race, every time,
  silently downgrading a genuinely signed-in student to guest-like,
  local-only tracking with no error surfaced anywhere. Earlier live
  verifications (Increment 2's decisions.md #12, Increment 3's daily
  challenge CTA) never caught this because they drove the Workshop via
  an in-app `<Link>` click from an already-loaded page (`/problems` →
  `/workshop`), where the auth store's module-level state was already
  warm from that page's own bootstrap — a real gap in how "verified
  live" was being exercised, not a false confidence from the wrong kind
  of test, but a narrower one than it should have been.
- **The fix:** `ScenarioDeepLink` now reads `useAuth().status` and,
  gated by a `useRef` so it still only ever actually loads once,
  defers its entire body until `status` has left `"idle"`/`"loading"` —
  i.e., until `bootstrap()` has genuinely resolved, signed in or not.
  For a guest this costs a near-instant microtask, not a real network
  wait (`bootstrap()` short-circuits to `status: "ready"` immediately
  when no tokens exist); for a signed-in student it's one real `/me`
  round-trip's worth of delay before the canvas populates — the canvas
  was already blank until this effect ran anyway, so this doesn't add a
  new visible blank-state window, only removes an invisible one that
  was silently corrupting tracking.
- **Verified live, both before and after the fix:** confirmed zero
  `POST /attempts` on a hard-loaded free-play URL pre-fix; confirmed a
  real `POST /attempts` (201) firing correctly post-fix, on the exact
  same hard-navigation test, for both free play and (spot-checked)
  Timed Challenge's `?timed=1` deep link.

### 20. Verified live end-to-end: start → submit → auto-restart → a second submit into a genuinely different attempt id

- Signed in as the existing Increment 3/4 test account, hard-loaded
  `/workshop?scenario=price-alert-notifications` (free play, no
  `&timed=1`), loaded the scenario's own reference solution, and ran
  the simulation twice.
- Real network requests, in order: `POST /attempts` (201, attempt A) →
  `POST /attempts/{A}/submit` (200) → `POST /attempts` (201, attempt B,
  fired automatically) → `POST /attempts/{B}/submit` (200, from the
  SECOND Run Simulation click — a genuinely new `simulationResult`
  object even on an unchanged passing graph, the same trigger
  `ScenarioCompletionToast` already uses) → `POST /attempts` (201,
  attempt C). Three distinct attempt ids confirmed from the raw request
  URLs, not inferred.
- Confirmed via `GET /leaderboards/best-solved` and `/most-solved`
  (curl, direct to the backend): both empty — this NO_PRESSURE solve
  correctly never appears on either board, matching
  `phase-6-leaderboards`'s and `phase-5-points-and-progress`'s own
  design.
- Confirmed the guest experience is untouched: signed out, hard-reloaded
  the same URL — zero new `/attempts` requests fired, exactly the
  existing local-only behavior.
- Zero console errors across the whole pass, both pre- and post-fix.

---

## Increment 6 — Progress history page

### 21. Signed-in-only throughout — no "guest-visible, auth-gated-extra" split like Increments 3's leaderboard/daily-challenge pages

- **Chose:** `/progress` shows a "Sign in to see your solved scenarios,
  points, and stars" prompt for guests, with no fetch attempted at all,
  rather than trying to render anything for a signed-out visitor.
- **Why this is NOT the same shape as decisions.md #14:**
  `GET /progress/scenarios` has no public/guest variant on the backend —
  `ProblemProgressController` takes `Authentication authentication` as a
  required parameter with no carve-out in `SecurityConfig` (unlike
  `/leaderboards/**` and `/daily-challenge/**`, both explicitly
  `permitAll()`'d). There's also no sensible guest-facing content this
  page COULD show even if the endpoint were public — "every scenario
  the SERVER has a real attempt for" is inherently about a specific
  signed-in identity, not a public ranking or a shared daily pick. A
  guest already has `/problems`' own local (`localStorage`) progress
  badges for the "what have I solved" question, without needing an
  account — this page is additive on top of that, not a replacement.
- **Considered:** faking a "public" empty state that still calls the
  endpoint and silently swallows the resulting 401. Rejected — an
  unauthenticated request that both parties already know will fail is
  pointless network traffic, not a legitimate guest experience.

### 22. Points/stars can legitimately read `—` on a `SOLVED` row — not a bug, the NO_PRESSURE case surfacing correctly

- **What this is:** `ProblemProgressService.recordOutcome` (Phase 5)
  marks a scenario `SOLVED` on ANY passing submit regardless of mode,
  but only a TIMED submit ever upgrades `bestStars`/`bestPoints`/
  `bestComposite`/`bestSpeedFactor` — a NO_PRESSURE-only solve leaves
  those at their defaults (0/0/null/null). Since Increment 5 wired free
  play into the backend, this is now a real, reachable case, not just a
  theoretical one.
- **Chose:** render `0` stars/points as `—` (an explicit dash), not a
  bare `0` — a `0` next to a green "Solved" badge reads as if something
  went wrong (partial credit? a scoring bug?); a dash reads as "this
  dimension doesn't apply here," which is the actual truth. The page's
  own subtitle also states this rule directly ("points and stars only
  count a Timed Challenge submission") so a first-time reader isn't left
  to infer it from the dash alone.
- **Verified against this exact case, not a hypothetical:** the live
  test account's own row (`price-alert-notifications`, solved via free
  play in Increment 5's testing) rendered exactly this way — confirmed
  during this increment's live pass, not assumed from reading the
  backend code alone.

### 23. Reuses `@/scenarios`' `getScenario()` for title/difficulty — no new backend field, no denormalization

- **Chose:** `ProblemProgressResponse` carries only `scenarioId`; the
  frontend resolves title/difficulty locally via `getScenario(id)`, the
  same lookup `/leaderboard`'s `MyLeaderboardStandingResponse` handling
  and `/daily-challenge`'s `DailyChallengeResponse` (which DOES carry a
  denormalized `scenarioTitle`) both already established as options.
- **Why the leaderboard-style lookup, not the daily-challenge-style
  denormalized field:** a daily challenge is exactly one scenario at a
  time, worth denormalizing for that endpoint's own simplicity; this
  page renders a whole LIST of scenario ids at once, all of which
  already exist in the frontend's own `src/scenarios/` catalogue — no
  new backend field or migration needed, and title/difficulty can never
  drift from what the frontend already shows everywhere else (`/problems`,
  the Workshop's own scenario briefing).
