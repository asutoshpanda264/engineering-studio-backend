# decisions.md — Contributor Pipeline

Decisions specific to the new `contribution`, `bugreport`,
`contributorapplication`, and `notification` packages. Project-wide
decisions live in `masterdoc/decisions.md`.

---

## 1. One generic `Contribution` type with a `category` enum, not three separate entities

- **Chose:** a single `Contribution` entity with `category`
  (`QUESTION`/`POST`/`VLOG`), `title`, `body`, an optional `link` (mainly
  for VLOG). One moderation queue, one points rule, one set of endpoints.
- **Rejected:** three separate entities/tables/controllers per content
  type. Would mean three near-identical CRUD surfaces and three approval
  queues for what's fundamentally one workflow (submit → review →
  award).
- **Scenario it covers:** if a fourth content type ever gets added, it's
  a new enum value and a new points-per-category entry, not a new
  package.

## 2. Fixed points per category, awarded once at approval, stored directly on the row — not a ledger

- **Chose:** `ContributionPointsCalculator.pointsFor(category)` (a pure,
  stateless static class, same shape as `points.PointsCalculator`) runs
  once, at approval, and the result is written straight to
  `Contribution.pointsAwarded`. A contributor's total is `SUM(pointsAwarded)`
  over their own `APPROVED` rows, computed on read
  (`ContributionRepository.totalApprovedPoints`) — not a stored running
  counter on `User`.
- **Rejected:** a separate `contribution_points_ledger` table mirroring
  `points_ledger` (Phase 5). That ledger exists because a scenario solve
  can be *re-scored* on a better re-attempt, so an audit trail of each
  award matters. A contribution's award is a one-time, deterministic
  constant that never changes after approval — there's no "improvement"
  event to replay, so a ledger's extra structure buys nothing here.
- **Scenario it covers:** `ContributorApplicationPriority`'s own
  `totalPoints` input reads scenario-solving points
  (`ProblemProgressRepository.aggregateLeaderboardStats`), not
  contribution points — a contributor's content-submission points and a
  user's problem-solving points are two genuinely separate numbers, never
  summed together.

## 3. Admin queues (`Contribution`'s pending-sorted-by-points, `ContributorApplication`'s top-5) are per-user aggregate queries + a Java sort, not one grouped SQL query

- **Chose:** fetch every PENDING row, then one small aggregate query per
  distinct submitter/applicant, then `Comparator.reversed()` in the
  service layer.
- **Rejected:** a single JPQL query with a correlated subquery or
  `GROUP BY` across every user. This codebase already made this exact
  call for the real leaderboards (`leaderboard.LeaderboardService`
  recomputes one user at a time, explicitly rejecting a single
  cross-user query — see `phase-6-leaderboards/decisions.md`) — matching
  that precedent here means one shape to reason about, not two.
- **Scenario it covers:** both queues are admin-only, low-traffic,
  uncached, and always recomputed fresh on read — the same "freshness
  over cleverness" call `ScenarioService.listDrafts` already makes.

## 4. `/bug-reports/{id}/review` is a `POST`, not a `PATCH`

- **Chose:** the same action-suffix convention `/scenarios/{id}/publish`
  and `/contributions/{id}/approve` already use.
- **Rejected:** `PATCH /bug-reports/{id}`. `SecurityConfig`'s CORS
  `allowedMethods` list is `GET, POST, PUT, DELETE, OPTIONS` — no
  `PATCH` — so this would have meant widening that list for the sake of
  one endpoint, a bigger surface-area change than just following the
  convention this app already has for a state-transition action.

## 5. `ContributorApplication`: self-service application is the *only* path into CONTRIBUTOR — no admin "Users" panel was built

- **Chose:** a plain USER applies (`POST /contributor-applications`, no
  body — see #6), an ADMIN reviews the top 5 by priority, approving
  flips the role directly.
- **Considered and set aside:** a general admin "browse all users, pick
  a role" panel. Genuinely useful (it's also the only way to bootstrap
  the very *first* admin — see `README.md`'s bootstrap note, done via a
  direct `UPDATE users SET role='ADMIN' ...` for now) but a materially
  bigger feature (a paginated/searchable user list, a raw promote-to-
  anything control with its own "who can be trusted to grant ADMIN"
  question) than what was actually asked for. Left for a later,
  explicit ask rather than built speculatively now.
- **Scenario it covers:** every admin account beyond the first is
  created by an application being approved, which itself requires an
  existing admin — there is currently no self-service path to ADMIN at
  all, by design.

## 6. No form fields on a contributor application — the decision is based on real stats, not a written pitch

- **Chose:** `POST /contributor-applications` takes no request body at
  all. The priority score
  (`ContributorApplicationPriority.score(solvedCount, totalPoints, currentStreak)`
  — `totalPoints + solvedCount×20 + currentStreak×10`, first-pass weights,
  deliberately simple per the 2026-09-19 chat: too few users with
  substantial solve histories yet for anything more elaborate to mean
  much) is the entire basis for ranking.
- **Scenario it covers:** revisit the weights (or add a real filtering
  UI instead of a flat top-5 cap) once there's an actual distribution of
  applicants to tune against — not before.

## 7. The anti-cheat score-freeze is keyed on the applicant's *current role*, not on "has ever applied"

- **Chose:** `ProblemProgressService.recordOutcome` checks
  `attempt.getUser().getRole() != Role.USER` and returns immediately if
  true — covering CONTRIBUTOR and ADMIN both, checked fresh on every
  submit.
- **Rejected:** freezing at the moment of *applying* (before approval).
  The stated cheat vector — `ScenarioController`'s
  `hasAnyRole('ADMIN','CONTRIBUTOR')` on scenario creation giving either
  role insider knowledge of a scenario's own scoring internals — doesn't
  exist for a plain applicant who hasn't been approved yet. Freezing
  before approval would protect against a *different* concern (gaming
  the priority queue's ranking while a decision is pending) that was
  never actually raised, at the cost of not matching the reasoning that
  *was* given.
- **Scenario it covers:** a rejected applicant keeps earning
  points/progress normally throughout and after their (unsuccessful)
  application — only an actual role change past USER changes this.

## 8. Email: our own `app.mail.*` properties, not Spring Boot's built-in `spring.mail.*`

- **Chose:** `EmailService` reads `app.mail.host`/`port`/`username`/
  `password`/`from` directly via `@Value`, and constructs a plain
  `JavaMailSenderImpl` itself only when `host` is non-blank.
- **Rejected:** autowiring Spring Boot's auto-configured `JavaMailSender`
  bean (from `spring.mail.*`). That auto-configuration activates the
  instant `spring.mail.host` resolves to *any* value — including the
  empty string a `${MAIL_HOST:}` placeholder produces when the env var
  is simply unset — which would hand this class a real bean that then
  fails at send-time (empty host) instead of a clean, checkable "not
  configured yet" state. Building the sender manually, gated on an
  explicit blank check, removes that ambiguity entirely.
- **Scenario it covers:** until real SMTP credentials are set via
  `MAIL_HOST`/`MAIL_PORT`/`MAIL_USERNAME`/`MAIL_PASSWORD`, every send
  just logs what it would have sent (confirmed live — see `README.md`'s
  test-status section) and returns — an approval can never fail, or even
  appear to, just because email isn't wired up yet. This also updates
  `phase-7-daily-challenge-streaks/decisions.md` #1's statement that
  "this project has no notification/email delivery mechanism" — it now
  does, though the specific 10pm daily-challenge reminder that entry
  describes still isn't built on top of it.

## 9. The approval email is `AFTER_COMMIT`, same reasoning as `leaderboard.LeaderboardService`'s own listener

- **Chose:** `ContributorApplicationService.approve` publishes
  `ContributorApplicationApprovedEvent` inside its own `@Transactional`
  method; `EmailService.onContributorApplicationApproved` is a
  `@TransactionalEventListener(phase = AFTER_COMMIT)`.
- **Scenario it covers:** an approval that later rolls back (a
  constraint violation, an unexpected exception) never sends a congrats
  email for a role change that didn't actually happen. Directly
  consequence: this path **cannot** be exercised by
  `ContributorApplicationCrudIntegrationTest` as written — every test
  method's transaction rolls back per `AbstractIntegrationTest`'s own
  default wrapping, so `AFTER_COMMIT` never fires there (the same
  documented limitation `LeaderboardIntegrationTest` works around by
  overriding it). Verified instead by hand against the real
  `docker compose` stack — see `README.md`'s test-status section.

## 10. Two real environment-fragility findings while testing this phase — not code bugs

- **Finding:** two separate full-suite (`./mvnw test`, 69 tests) runs in
  the development sandbox broke identically, ~24 minutes in — every
  running Docker container (including some from a completely unrelated
  project sharing the same machine) died simultaneously with
  `CannotCreateTransaction`/`Connection refused` errors partway through.
  Both new integration test classes from this phase pass cleanly (4/4,
  2/2, 4/4) in isolation, and the same failure pattern hit long-standing,
  previously-merged test classes identically — clear evidence of a
  resource ceiling in that specific sandbox, not a regression introduced
  here.
- **Scenario it covers:** a clean full-suite run should happen on a
  machine or CI with real headroom before this phase ships for real —
  see `README.md`'s own note.
