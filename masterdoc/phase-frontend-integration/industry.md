# industry.md — Frontend Integration

How real-world systems solve the same problems this phase solved, and how
this project's approach compares. See `decisions.md` for why each choice was
made and `explain_frontend_integration.md` for how the mechanisms actually
work — this file adds the external comparison only.

---

### 1. Short-lived access token + refresh token, with exactly one retry on a 401

**The problem**: a client holding a token that can expire mid-session needs
a way to transparently get a new one without forcing a re-login on every
expiry, while not masking a genuinely revoked/invalid session as an
infinite retry loop.

**How this project does it**: `authStore.ts#authenticatedRequest` attaches
the current access token to every call and, on exactly one 401, calls
`/auth/refresh` once before retrying the original request once — a second
401 after a successful refresh is treated as a real logged-out state, not
retried again. See `decisions.md` #3.

**Industry approaches**: this is the standard OAuth2 access-token/
refresh-token shape (RFC 6749) — a short-lived access token limits the
damage window if it leaks, and a longer-lived refresh token (itself
revocable server-side) is exchanged for a new one without re-prompting for
credentials. Auth0's and Okta's own public documentation describe the same
"intercept a 401, refresh once, retry once" pattern client SDKs implement,
and it's the same shape `axios`-interceptor or Apollo-Client
`errorLink`-based refresh recipes commonly used in SPAs implement — a
single-flight refresh, not per-caller retry logic duplicated everywhere.

**Why this project differs (or doesn't)**: it doesn't differ — this is the
textbook version of the pattern, deliberately centralized: `decisions.md`
#3 states the reasoning industry SDKs give for the "exactly once" rule
directly — a second 401 right after a successful refresh means the refresh
token itself is dead, and retrying further would either loop forever or
present a hang instead of a clear logged-out state.

**Trade-offs**:
- Gives up: no refresh-request de-duplication for multiple concurrent 401s
  firing at once (a production SDK often coalesces simultaneous refreshes
  into a single in-flight request so five parallel calls that all 401
  together don't each trigger their own `/auth/refresh`) — not yet a
  problem at this app's actual call volume (a handful of sequential
  fetches per page, not a burst of parallel requests).
- Gains: the entire retry-on-expiry behavior lives in one function
  (`authenticatedRequest`), not reimplemented per call site — simpler to
  read and audit than a full SDK's token-refresh queue.
- Worth revisiting if: a page ever fires several authenticated requests in
  true parallel (not the current one-call-at-a-time pattern) — that's the
  point simultaneous 401s could trigger redundant concurrent refresh calls,
  and request coalescing would start earning its complexity.

### 2. Bearer token in a header, read from `localStorage` — not an `httpOnly` cookie

**The problem**: a browser-based client authenticating to a separate API
origin has to decide where the credential lives and how it's transmitted —
that choice trades one class of attack (XSS reading a token out of
JS-accessible storage) against another (CSRF exploiting a cookie the
browser attaches automatically).

**How this project does it**: tokens are written to `localStorage`
(`src/lib/auth/tokens.ts`) and attached manually as an `Authorization`
header by `authenticatedRequest`; the backend's CORS config explicitly
sets `allowCredentials = false`, since no cookie ever crosses the
frontend↔backend origin boundary. See `decisions.md` #4.

**Industry approaches**: this is one of the two standard SPA-auth patterns
publicly debated and documented — Auth0's own engineering blog and OWASP's
guidance both lay out the same trade-off this project resolved:
`localStorage` + `Authorization` header is simpler (no CSRF surface, since
nothing is sent automatically) but exposed to any successful XSS on the
page; an `httpOnly` cookie is immune to being read by injected JS but
reintroduces CSRF, requiring its own mitigation (a `SameSite` attribute,
or a separate anti-CSRF token). Cookie-based session auth is the more
common choice for a first-party web app serving its OWN frontend and
backend from the same origin (where CSRF defenses are cheaper to add and
same-origin cookies just work); the header-token approach is more common
specifically for the cross-origin, separately-deployed frontend/backend
shape this project actually has.

**Why this project differs (or doesn't)**: it doesn't differ from the
standard cross-origin-SPA choice — the two repos are genuinely separate
deployments (`engineering_studio` on one origin, this API on another), the
exact shape where the header-token pattern is the more commonly reached-for
of the two, not a corner cut.

**Trade-offs**:
- Gives up: cookie-based auth's immunity to token theft via XSS — anything
  that can run injected JS on `engineering_studio` could read the token
  out of `localStorage`. This project carries the same exposure any
  header-token SPA does, mitigated only by the general practice of not
  having an XSS vulnerability in the first place, not by a second layer of
  defense the cookie approach would add for free.
- Gains: no CSRF surface at all (nothing is sent automatically by the
  browser), and a much simpler CORS story — `allowCredentials: false` is
  strictly safer and simpler to configure correctly than the
  credentialed-CORS setup a cross-origin cookie would require.
- Worth revisiting if: the app ever needs to defend against a realistic XSS
  vector this scale hasn't had to consider (untrusted user-generated
  content rendered without sanitization, a compromised third-party script)
  — that's the point an `httpOnly` cookie's XSS-immunity would outweigh the
  CSRF mitigation it requires.

### 3. Guest-first, sign-in-as-additive — never a login wall

**The problem**: a product that wants accounts (to persist progress, rank
users, enable a daily-engagement feature) has to decide whether an account
is required up front or optional, and that choice shapes how much of the
product a first-time, not-yet-committed visitor can actually experience.

**How this project does it**: signing in adds a parallel, server-tracked
path on top of the Workshop's existing fully-local experience — nobody is
redirected to `/login` by anything this phase built, and the guest path
(`localStorage`-based progress, local instant scoring) is untouched. The
same split extends to every new page: `/leaderboard` and `/daily-challenge`
render fully for guests, with only the "your rank"/streak/history parts
additionally gated on `useAuth().user`. See `decisions.md` #1 and #14.

**Industry approaches**: "browse and use the core product for free, create
an account specifically to have your activity persist/count/rank" is a
widely-recognized product pattern — this project's own `decisions.md` #1
names the exact comparison independently: LeetCode itself lets anyone solve
a problem with no account, requiring sign-in only so a solve counts toward
a profile and a ranked position. Figma and Notion both let a visitor
interact with a shared document or template with no account, gating only
the save/persist/collaborate step behind sign-up. This is also the
standard shape of "progressive enhancement" applied to auth specifically:
the ungated experience is the whole product's baseline, not a crippled
preview of it.

**Why this project differs (or doesn't)**: it doesn't differ — this is a
deliberate continuation of a product decision made before this phase even
started (the frontend's own pre-existing "blank playground, no login wall"
identity, per `decisions.md` #1's citation of `docs/CLAUDE.md`), not a
technical simplification. Wiring in a real backend was explicitly done in
a way that couldn't regress that identity.

**Trade-offs**:
- Gives up: nothing structural — this isn't a lesser version of an
  account-gated product, it's the same "free to use, accounts for
  persistence" shape LeetCode and Figma ship at real scale.
- Gains: zero signup friction for a first-time visitor evaluating whether
  the product is worth an account at all — the actual reason this pattern
  is common in the products it's borrowed from.
- Worth revisiting if: never, on the core principle — the one place this
  project genuinely diverges from the guest-visible pattern is Increment
  6's `/progress` page (`decisions.md` #21), and that's because the
  underlying data (a specific signed-in identity's own history) has no
  sensible guest-facing content to show at all, not a change of philosophy.

### 4. A subscription-based external store (`useSyncExternalStore`) instead of a state-management library

**The problem**: cross-cutting client state (auth, in this case) needs to
be readable and reactively updatable from components that aren't
necessarily nested under one shared provider, without each consumer
re-implementing its own fetch/cache/subscribe logic.

**How this project does it**: `authStore.ts` is a plain module — a
module-level cache, a listener `Set`, and `useSyncExternalStore` — matching
the exact shape `ThemeProvider` and `problemProgress.ts` already use
elsewhere in this codebase, deliberately not Zustand (already a real
dependency, used for `workshopStore.ts`) or a Context provider. See
`decisions.md` #2.

**Industry approaches**: `useSyncExternalStore` is React's own official
primitive (added in React 18, documented directly in React's docs)
specifically for subscribing a component to state that lives outside
React's own render tree — it's the same hook state-management libraries
use internally: Zustand's own `useStore` implementation is built on top of
it, as is Jotai's core subscription mechanism. Building a small module-level
store directly on this primitive rather than reaching for a library is a
recognized minimal-dependency pattern for exactly the case this project
hit — a handful of consumers, no deeply-nested prop-drilling problem to
solve — versus Context, which is the React-idiomatic answer specifically
for the "many deeply-nested consumers" shape (theme, i18n, a design
system's tokens).

**Why this project differs (or doesn't)**: it doesn't differ from an
established pattern already living in this exact codebase — the decision
was to match precedent (`problemProgress.ts`'s own stated preference) over
introducing a second state-management approach for one more cross-cutting
concern, not a rejection of Zustand or Context on technical grounds.

**Trade-offs**:
- Gives up: none of what Context/Zustand actually add over this — no
  built-in devtools/time-travel debugging (Zustand's), no
  provider-scoped instances if this ever needed more than one auth store
  at once (it doesn't).
- Gains: one fewer dependency exercised for a feature with only a handful
  of read sites, and consistency with two other pieces of state
  (`ThemeProvider`, `problemProgress.ts`) already built this exact way in
  this codebase — a new contributor learns one pattern, not three.
- Worth revisiting if: the number of cross-cutting global stores in this
  codebase grows enough that duplicating this same
  cache+listener-Set+`useSyncExternalStore` boilerplate per store stops
  paying for itself versus adopting Zustand (already present) uniformly
  for all of them.

### 5. Deferring a dependent effect until an async client-state hydration resolves

**The problem**: when one piece of async, module-level state (a signed-in
session, restored from storage) and a synchronous effect that depends on
it both fire in the same render commit, the dependent effect can read a
stale/default snapshot before the async state has actually resolved — a
race that produces no error, just silently wrong behavior.

**How this project does it**: `ScenarioDeepLink` and `AuthBootstrap` both
mount in the same commit on a hard `/workshop` page load;
`ScenarioDeepLink` originally called `getCurrentUser()` synchronously in
that same tick, always reading `null` (the store has no synchronous
`localStorage` hydration, only the real async `/me` fetch) — silently
downgrading a genuinely signed-in student to guest-like tracking with no
error anywhere. The fix makes `ScenarioDeepLink` read `useAuth().status`
and defer its entire body until that status leaves `"idle"`/`"loading"`,
i.e. until bootstrap has genuinely resolved either way. See `decisions.md`
#10 and #19.

**Industry approaches**: this is a specific instance of a broadly-known
class of bug in client-rendered apps with async auth state — often
informally called a "flash of unauthenticated content" or an auth
hydration race, and it's exactly why session-management libraries for
React (NextAuth.js/Auth.js's `useSession()`, Clerk's `useAuth()`/`useUser()`)
expose an explicit loading/pending status as a THIRD state distinct from
signed-in and signed-out — precisely so a consuming component can defer
rendering or side effects until that status settles, rather than treating
an unresolved session as equivalent to "definitely signed out." Redux
apps solve the analogous problem with an explicit `"idle"`/`"loading"`/
`"succeeded"`/`"failed"` status enum on async slices (a pattern Redux
Toolkit's own documentation recommends) for the same reason — so a
consumer can distinguish "not yet known" from "confirmed absent."

**Why this project differs (or doesn't)**: it doesn't differ from how
session libraries solve this — the fix this project landed on (an explicit
third status a dependent effect waits on) is the same shape
`Auth.js`/Clerk expose as a first-class API. The gap wasn't a design
choice, it was `ScenarioDeepLink` originally treating a synchronous
snapshot as authoritative, an easy mistake this project made and then
corrected once live testing (a genuine hard page load, not an in-app
navigation) exposed it — `decisions.md` #19 is explicit that earlier live
verifications missed it specifically because they never exercised a cold
load.

**Trade-offs**:
- Gives up: nothing versus the pattern — the fix aligns with how dedicated
  session libraries already expose this exact state machine; there's no
  cheaper "acceptable" version of solving this correctly.
- Gains: for a signed-in student, one real `/me` round-trip's worth of
  delay before a deep-linked scenario populates, in exchange for correct
  attempt tracking every time instead of silently-sometimes-wrong tracking
  depending on how the page was reached.
- Worth revisiting if: this same "async state resolves in a separate
  effect from something that depends on it" shape shows up again elsewhere
  in the frontend (any future module-level store with async hydration) —
  the general lesson `decisions.md` #10/#19 draws (a guaranteed-mounted
  trigger, and dependents gated on an explicit not-yet-resolved status) is
  the fix to reach for immediately, not rediscover.

### 6. A bounded, one-shot grading window mapped onto an unbounded practice loop as two separate lifecycles

**The problem**: a system that both grades a single timed attempt AND
supports unlimited untimed practice on the same underlying content needs
two different session shapes for those two modes — a naive one-size-fits-all
"submit every attempt" model either discards most practice runs or forces
a bounded shape onto a loop that was never meant to end.

**How this project does it**: only an active Timed Challenge creates a
backend `Attempt` that gets submitted once, on its first passing run
(`decisions.md` #7-#9); free play (Increment 5) instead runs a loop —
start an attempt on scenario load, submit on the first passing run,
immediately open a fresh attempt for the same scenario so a later, better
run can submit again (`decisions.md` #18). Both rely on the same backend
invariant (an `Attempt` accepts exactly one submit, ever), just wired to
two different frontend session shapes.

**Industry approaches**: this exact bounded-vs-unbounded split is the
standard shape of competitive-programming judges. Codeforces (and similar
judges) treat a submission made during an active, timed contest window as
the one that's graded/ranked for that contest, while the identical problem
remains open for unlimited untimed "practice" submissions afterward that
never affect a contest standing — two different grading lifecycles over
the same problem, the same distinction this project draws between Timed
Challenge and free play. LeetCode's own contest-vs-practice split for the
same problem follows the identical shape.

**Why this project differs (or doesn't)**: it doesn't differ in shape —
`decisions.md` #7 explicitly reasons from the backend's own one-shot
`Attempt` model outward to find which frontend interaction already had
"start once, this run is the graded one" semantics (Timed Challenge), the
same bounded-window concept a contest judge enforces. The free-play loop
is a smaller-scale version of "unlimited practice submissions" — every
passing run gets its own attempt id rather than one practice session
tracking many submissions under a single id, a simplification that fits
this project's actual need (one user, one browser tab, no submission
history UI to populate) rather than a contest judge's need to list every
past practice submission.

**Trade-offs**:
- Gives up: no per-scenario submission history for free play — a contest
  judge like Codeforces lets you browse every past practice submission for
  a problem; this project's free-play loop creates and discards attempt
  ids with no browsable list of them (Increment 6's `/progress` page shows
  only the BEST result per scenario, not a submission log).
- Gains: no submission-list data model or UI to build for a feature
  nothing in this project currently needs — "best result so far" is the
  only thing `/progress` and the leaderboards actually care about.
- Worth revisiting if: a future feature wants to show a student their own
  attempt-by-attempt history on a scenario (not just their best) — that's
  the point a real submission-list model, closer to what a contest judge
  exposes, would earn its complexity over "discard and re-arm."

---

## Summary

This phase's mechanisms split cleanly into "the standard pattern, applied
correctly" and "a real bug caught by actually running the connected
stack." The access/refresh token flow, the guest-first product shape, and
the bounded-vs-unbounded attempt lifecycle are all the same designs
industry systems (OAuth2 SDKs, LeetCode/Figma, competitive-programming
judges) use for the same reasons, scaled down to this project's actual
needs without losing anything structural. The header-token-vs-cookie and
`useSyncExternalStore`-vs-library choices are genuine, informed trade-offs
matching precedent already in this codebase, not gaps. The one place this
phase's own honest self-assessment matters most is the auth-hydration
race (#5): it wasn't a scale-appropriate simplification, it was a real bug
that shipped once (silently mistracking a signed-in student's attempts)
and was only caught because Increment 5's live verification happened to
use a hard page load instead of an in-app navigation — the fix now matches
what dedicated session libraries expose as a first-class API, but it's
worth flagging that the SAME class of bug (an async store's dependents not
gating on its not-yet-resolved state) could recur anywhere else in this
frontend that adds a new module-level async store without deliberately
reapplying this lesson.
