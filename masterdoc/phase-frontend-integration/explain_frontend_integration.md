# explain_frontend_integration.md — how the two apps actually talk to each other

## The two repos, at a glance

```
engineering-studio-backend/     (this repo)
  api/       Spring Boot — everything Phases 1-8 built
  verify/    Node — server-side scoring
  masterdoc/ this — spans all three, including the frontend connection

engineering_studio/              (sibling repo, NOT part of this one)
  src/lib/api/       the HTTP client this phase added
  src/lib/auth/      the auth store this phase added
  src/app/login/,
  src/app/register/  new pages this phase added
  src/scenarios/,
  src/simulation/    the frontend's OWN local simulation engine —
                     unrelated to verify/, pre-existing, untouched
```

Local dev: `api/` on :8080 (`./mvnw spring-boot:test-run` — Testcontainers-backed
Postgres+Redis, the same convenience Phase 1 built for backend-only local
dev), `verify/` on :4000 (`npm run dev`), `engineering_studio` on :3000
(`npm run dev`). `NEXT_PUBLIC_API_BASE_URL` (`.env.local`, untracked)
points the frontend at the backend's base URL.

## The auth request path

```
Browser (localhost:3000)
  │
  ▼
src/lib/auth/authStore.ts's login()/register()
  │  POST /auth/login or /auth/register — apiRequest(), no token yet
  ▼
src/lib/api/client.ts's apiRequest()
  │  fetch(`${NEXT_PUBLIC_API_BASE_URL}${path}`, ...)
  ▼
engineering-studio-backend/api :8080
  │  SecurityConfig's CORS filter (Increment 1) checks Origin against
  │  app.cors.allowed-origins — this is what makes the browser's
  │  preflight OPTIONS (and the real request) succeed at all
  ▼
AuthController → TokenPairResponse { accessToken, refreshToken }
  │
  ▼
authStore.ts: writeTokens(...) (localStorage) → authenticatedRequest("/me")
  │  → UserResponse → setState({ user, status: "ready" }) → every
  │    useAuth() subscriber (AuthStatus, any future page) re-renders
```

Every SUBSEQUENT authenticated call goes through
`authStore.ts#authenticatedRequest`, which attaches the current access
token and, on exactly one 401, tries `/auth/refresh` once before retrying
— see decisions.md #3 for why exactly once, not a loop.

## The reactive auth store's shape

`useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)` — same
shape as `@/components/theme/ThemeProvider` and `@/lib/problemProgress`
(see decisions.md #2 for why this pattern over Zustand/Context). SSR gets
`IDLE_STATE` (`{ user: null, status: "idle" }`, a stable module-level
constant — see decisions.md #5 for the real bug hit here); the real
client-side value is only knowable after `useAuth()`'s own `useEffect`
runs `bootstrap()`, which reads `localStorage` and — if a token pair
exists — calls `/me` to rehydrate the actual user.

## Guest vs. signed-in — where the split actually happens

Nothing NEW gates the existing guest experience — `@/lib/problemProgress`
and friends are completely untouched, and nobody is redirected to
`/login` by anything built so far. `AuthStatus` (the header widget) is
the only place a visitor sees the two states differ: "Sign in / Create
account" links when `user` is `null`, the user's display name + streak +
a logout button when it isn't.

**Increment 2** is where the actual branching logic lives — see below.

## Increment 2 — the Timed Challenge → backend attempt path

Only Timed Challenge creates backend attempts (see decisions.md #7 for
why NO_PRESSURE/free-play stays local-only for now):

```
InspectorPanel's "Start Timed Challenge" (or ?timed=1, or Restart)
  ▼
workshopStore.ts#startTimedChallenge()
  │  timedModeStartedAt = Date.now()   -- LOCAL, synchronous, instant —
  │                                       the countdown starts regardless
  │                                       of what happens next
  │  getCurrentUser() === null?  → return (guest — nothing else happens)
  ▼
startAttempt(scenarioId, "TIMED")        (src/lib/api/attempts.ts)
  │  → authenticatedRequest("/attempts", POST)
  ▼
POST /attempts  →  engineering-studio-backend :8080
  │  AttemptService.start — Attempt(status=IN_PROGRESS, startedAt=now)
  ▼
backendAttemptId = attempt.id   -- guarded: only applied if
                                    timedModeStartedAt is STILL this
                                    session's value (see decisions.md #10
                                    for the stale-response race this closes)

... student builds, runs Run Simulation as many times as they want ...

ScenarioCompletionToast.tsx's existing "genuinely new passing result" effect
  │  (the SAME trigger recordSolved — local progress — already uses)
  ▼
workshopStore.ts#submitBackendAttempt()
  │  no-op unless backendAttemptId is set AND status is "idle"
  │  canvasToClientGraph(nodes, edges)     (src/lib/workshopSubmission.ts —
  │                                          the exact inverse of
  │                                          entitiesToCanvas)
  ▼
submitAttempt(attemptId, graph)          (src/lib/api/attempts.ts)
  ▼
POST /attempts/{id}/submit  →  engineering-studio-backend :8080
  │  real verify-service call, real scoring, real points/progress/
  │  leaderboard/streak side effects — everything Phases 4-7 built
  ▼
on success: backendAttemptId = null (terminal — see decisions.md #8),
            refreshUser() — re-fetches /me so AuthStatus's streak badge
            reflects the new state without a page reload
on failure: backendAttemptStatus back to "idle" (same attemptId kept —
            a later passing run in this SAME challenge retries it),
            logged to console, nothing surfaced to the student — the
            local toast/celebration already happened and stays valid
            either way
```

## The graph payload shape

`canvasToClientGraph` turns live `ArchitectureNode[]`/`ArchitectureEdge[]`
canvas state into `{nodes, connections}` — field-for-field the same
`ClientGraph` shape `engineering-studio-backend/verify/src/graphAdapter.ts`
already documented expecting "the same shape the frontend's own Workshop
canvas produces." No new contract invented on either side — this
increment just finally exercises one both repos already agreed on.

## Verified live (see decisions.md #12 for the full trail)

Loaded a scenario's own reference solution (`loadOptimalSolution()` —
avoids needing to drive React Flow drag-and-drop through browser
automation just to prove the wiring), started a Timed Challenge, ran the
simulation once. Real network requests: `POST /attempts` (201) →
`POST /attempts/{id}/submit` (200) → `GET /me` (200, the refresh). Real
backend state, checked directly: a genuinely `SOLVED` `problem_progress`
row with real star/points/composite/speedFactor values, and that same
user showing up on the real Redis-backed `best-solved` leaderboard.

## Increment 3 — the leaderboard/daily-challenge pages' read-only path

No new write path — these two pages are pure GETs onto Phase 6/7's
existing endpoints, plus one link back into Increment 2's already-built
attempt flow:

```
/leaderboard (src/app/leaderboard/page.tsx)
  │  on mount + every tab switch:
  ▼
getLeaderboard(activeType)              (src/lib/api/leaderboards.ts)
  │  → apiRequest — NO auth header, works for guests
  ▼
GET /leaderboards/{type}  →  LeaderboardEntryResponse[]  (Phase 6 ZSETs)

  │  only if useAuth().user is set:
  ▼
getMyLeaderboardStanding(activeType)
  │  → authenticatedRequest
  ▼
GET /leaderboards/{type}/me  →  MyLeaderboardStandingResponse
                                 ({ ranked: false } is a normal response,
                                  not an error, for a never-ranked user)
```

```
/daily-challenge (src/app/daily-challenge/page.tsx)
  │  on mount:
  ▼
getTodayChallenge()                     (src/lib/api/dailyChallenge.ts)
  │  → apiRequest — NO auth header
  ▼
GET /daily-challenge/today  →  DailyChallengeResponse  (Phase 7)

  │  only if useAuth().user is set:
  ▼
getMyDailyChallengeStanding() + getDailyChallengeHistory()
  │  → authenticatedRequest
  ▼
GET /daily-challenge/today/me, GET /daily-challenge/history

"Solve it" CTA (rendered only when NOT completedToday):
  ▼
<LinkButton href={`/workshop?scenario=${scenarioId}&timed=1`}>
  │  the SAME ScenarioDeepLink query shape Increment 2's Timed Challenge
  │  flow already reads — see the diagram above starting at
  │  "InspectorPanel's Start Timed Challenge (or ?timed=1, ...)"
  ▼
...the whole Increment 2 path runs unmodified, and
DailyChallengeService.onScenarioSolved (Phase 7, not this phase) does
the actual completion-crediting once the submit lands — see
decisions.md #13.
```

Both pages key their fetched state by which tab/request it answers
(rather than clearing to `null` synchronously inside the effect) so a
stale in-flight response for a previously-selected leaderboard tab can
never render itself under the tab now on screen — see decisions.md #15.

## Verified live — Increment 3 (see decisions.md #16 for the full trail)

Registered a fresh account through the real UI, then drove both new
pages as guest and signed-in via `claude-in-chrome`: real
`GET /leaderboards/{type}` and `GET /daily-challenge/today` requests
(200s) with real data, correct empty/never-ranked/zero-streak states for
a brand-new account, and the "Solve it" CTA's rendered `href` confirmed
exact, landing in a real running Timed Challenge with a real
`POST /attempts` (201) already fired. Zero console errors across the
whole pass.

## Increment 4 — the Workshop header's own auth indicator

No new request path — `WorkshopAuthStatus` reads the exact same
`useAuth()` store every other auth-aware component already reads
(`AuthStatus`, the Workshop submit flow). What's new is purely a second,
width-conscious UI for the same state, mounted somewhere `AuthStatus`
itself never was:

```
WorkshopHeader.tsx
  │  mounts <WorkshopAuthStatus /> between ThemeToggle and the
  │  Export/Settings icon group
  ▼
WorkshopAuthStatus (src/components/workshop/WorkshopAuthStatus.tsx)
  │  useAuth() — same module-level store as everywhere else; bootstrap
  │  already runs on every page via AuthBootstrap (Increment 2), so no
  │  new wiring was needed for this widget to have real data by the
  │  time it first renders
  ▼
status !== "ready"  → 32×32px invisible placeholder (layout stability)
!user               → icon-only "Sign In" link to /login (label at xl+)
user                → [streak flame, xl+ only, if > 0]
                      [user icon + truncated name, name at xl+ only]
                      [ghost "Sign out" icon button → logout()]
```

See decisions.md #17 for why a purpose-built widget, not `AuthStatus`
itself, was the fix — and why this finally closes the gap Increment 2's
decisions.md #11 explicitly left open rather than rushed.

## Increment 5 — free play's own attempt lifecycle, and the bootstrap race it exposed

Free play has no session boundary the way Timed Challenge's countdown
does, so its attempt lifecycle is a loop, not a bounded start→submit
pair:

```
loadScenario(id)  (a fresh scenario view — the default, non-timed case)
  ▼
startFreePlayAttempt(id)
  │  no-op for guests
  ▼
POST /attempts  { scenarioId: id, mode: "NO_PRESSURE" }
  ▼
freePlayAttemptId = attempt.id   -- guarded: only if activeScenarioId is
                                    STILL this id AND timedModeStartedAt
                                    is still null (mirrors
                                    startTimedChallenge's own
                                    stale-response guard, keyed off
                                    scenario id instead of a timestamp —
                                    free play has no "session start"
                                    moment to compare against)

... student builds, runs Run Simulation as many times as they want ...

ScenarioCompletionToast's "genuinely new passing result" effect — SAME
trigger as Timed Challenge, unmodified
  ▼
submitBackendAttempt()
  │  timedModeStartedAt === null → free-play branch
  │  no-op unless freePlayAttemptId is set AND status is "idle"
  ▼
POST /attempts/{id}/submit   → real verify-service call, real
                                points/progress/streak side effects
                                (points stay 0 — NO_PRESSURE, see
                                ProblemProgressService)
  ▼
on success: freePlayAttemptId = null, refreshUser(), THEN immediately
            startFreePlayAttempt(activeScenarioId) again — a fresh
            attempt is ready before the student's next Run Simulation
            click, with no visible gap. THIS is "allow re-submitting a
            better later attempt" (decisions.md #7) — not a special
            resubmit endpoint, just a new attempt id every time.
on failure: backendAttemptStatus back to "idle" (same id kept — the
            next genuinely new passing run retries it), logged to
            console, nothing surfaced to the student.
```

### The bootstrap race this increment's live testing exposed (decisions.md #19)

`ScenarioDeepLink` (`src/app/workshop/page.tsx`) fires on mount, in the
same commit as `AuthBootstrap`'s own mount effect. Before this
increment, `ScenarioDeepLink` called `loadScenario`/`startTimedChallenge`
synchronously, immediately — including on a genuine hard page load,
before `AuthBootstrap`'s real `GET /me` network round-trip had any
chance to resolve. `getCurrentUser()` is a synchronous, point-in-time
snapshot (`authStore.ts` has no synchronous localStorage-based user
hydration, only the real async fetch), so on a hard load it was ALWAYS
still `null` at the moment `startTimedChallenge`/`startFreePlayAttempt`
checked it — silently downgrading a genuinely signed-in student to
guest-like tracking, with no error anywhere. Fixed by having
`ScenarioDeepLink` read `useAuth().status` and defer its whole body
(gated by a `useRef` so it still only ever runs once) until status has
left `"idle"`/`"loading"`. This affected Timed Challenge too — it just
happened not to get caught until Increment 5's live testing used a hard
`navigate()` instead of an in-app `<Link>` click.

## Verified live — Increment 5 (see decisions.md #20 for the full trail)

A hard-loaded free-play `/workshop?scenario=...` URL, signed in: real
`POST /attempts` (201) → `POST /attempts/{id}/submit` (200) → a fresh
`POST /attempts` (201), across two Run Simulation clicks, three distinct
attempt ids confirmed from the raw request URLs. `GET /leaderboards/*`
(curl, direct to the backend) confirmed the NO_PRESSURE solve stayed off
both boards. The race-condition fix verified both ways: reproduced (zero
`POST /attempts`) before the fix, confirmed fixed (a real 201) after it,
on the identical hard-navigation test. Guest behavior unchanged. Zero
console errors throughout.
