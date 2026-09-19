# Contributor Pipeline — content submissions, bug reports, and self-service contributor applications

**Status:** ✅ done, verified live against the real `docker compose` stack.
Not one of the numbered 1-9 milestones from the approved build plan
(`/home/asutosh/.claude/plans/lets-dicuss-more-what-zany-swing.md`) — a
separate initiative, same shape as `phase-frontend-integration/`, built
from a Sept 18-19 2026 chat rather than the original plan.

## What this is

Three related but independently-shippable pieces, all landed in the same
short stretch of work:

1. **Contribution** — a CONTRIBUTOR/ADMIN submits a QUESTION/POST/VLOG;
   an ADMIN approves or rejects it from a queue ordered by the
   submitter's own total *approved* points, descending. Approval awards a
   fixed point value per category. This is a brand-new, separate
   "Community" content pipeline — it does **not** touch the existing
   `Scenario` DRAFT/PUBLISHED pipeline (Phase 2) or the frontend's static
   `src/content/*` files.
2. **BugReport** — any signed-in role (USER/CONTRIBUTOR/ADMIN) files one;
   an ADMIN works it through an OPEN → IN_PROGRESS → RESOLVED workflow
   with a free-text note.
3. **ContributorApplication** — the actual, only path a plain USER has
   into the CONTRIBUTOR role. Self-service, no form fields (the decision
   is based on the applicant's own real stats, not a written pitch): an
   ADMIN only ever sees the **top 5** pending applications, ranked by a
   priority score combining solved count, total points, and daily streak
   — deliberately not every pending row, since this could run into the
   hundreds with no filtering UI yet. Approving flips `User.role` to
   CONTRIBUTOR in the same transaction as the application's own status
   write, and queues a congrats email (`notification.EmailService`,
   `AFTER_COMMIT`) that logs instead of sending until real SMTP
   credentials are configured.

**A real anti-cheat rule came out of designing the application flow**:
`ProblemProgressService.recordOutcome` now returns immediately — no
`problem_progress` row, no points ledger entry, no
`ScenarioSolvedEvent`/`ProblemProgressUpgradedEvent` (so no streak or
leaderboard update either) — for any attempt whose user's role isn't
plain USER. Both CONTRIBUTOR and ADMIN can author or moderate scenarios
(`ScenarioController`'s `hasAnyRole('ADMIN','CONTRIBUTOR')` on create,
`hasRole('ADMIN')` on publish/archive/delete), which gives either one
insider knowledge of a scenario's own scoring internals — letting that
also count toward their own progress would be a real way to cheat. The
Workshop still behaves identically for them (the attempt is still
verified/scored in the response); it just never persists past the
`Attempt` row itself.

## Files in this repo

- `api/src/main/java/.../contribution/` — `Contribution`,
  `ContributionCategory`, `ContributionStatus`, `ContributionRepository`,
  `ContributionPointsCalculator`, `ContributionMapper`,
  `ContributionService`, `ContributionController`, `dto/`
- `api/src/main/java/.../bugreport/` — `BugReport`, `BugReportStatus`,
  `BugReportRepository`, `BugReportMapper`, `BugReportService`,
  `BugReportController`, `dto/`
- `api/src/main/java/.../contributorapplication/` —
  `ContributorApplication`, `ContributorApplicationStatus`,
  `ContributorApplicationApprovedEvent`,
  `ContributorApplicationRepository`, `ContributorApplicationPriority`,
  `ContributorApplicationMapper`, `ContributorApplicationService`,
  `ContributorApplicationController`, `dto/`
- `api/src/main/java/.../notification/EmailService.java` (new) — the
  congrats-on-approval email, `@TransactionalEventListener(AFTER_COMMIT)`
- `api/src/main/java/.../progress/ProblemProgressService.java` (edited)
  — the CONTRIBUTOR/ADMIN score-freeze, one early `return` at the top of
  `recordOutcome`
- `api/src/main/resources/db/migration/V6__contribution.sql`,
  `V7__bug_report.sql`, `V8__contributor_application.sql`
- `api/src/main/resources/application.yml` (edited) — the `app.mail.*`
  block (see decisions.md #4 for why not `spring.mail.*`)
- `api/pom.xml` (edited) — `spring-boot-starter-mail`
- `api/src/test/java/.../contribution/ContributionCrudIntegrationTest.java`,
  `.../bugreport/BugReportCrudIntegrationTest.java`,
  `.../contributorapplication/ContributorApplicationCrudIntegrationTest.java`
- `load-test/` (new, repo root) — a k6 script covering
  register/login/leaderboard/daily-challenge/attempt-start/attempt-submit,
  ramping to 500 VUs (see its own README)
- `docker-compose.yml`, `api/Dockerfile`, `verify/Dockerfile` (new,
  pre-existing local-dev infra this work was verified against live)

**Frontend** (`engineering_studio`, sibling repo):
- `src/app/contribute/page.tsx` — submit form + own-submission status +
  (for a plain USER) the "Apply to be a Contributor" panel
- `src/app/admin/page.tsx` — three sections: contributions queue, bug
  reports, contributor applications (all approve/reject from here)
- `src/lib/api/contributions.ts`, `bugReports.ts`,
  `contributorApplications.ts`, `types.ts` (extended)
- `src/components/layout/PrimaryNav.tsx` — role-conditional
  "Contribute"/"Admin" tab
- `src/components/support/ReportBugButton.tsx` — the site-wide floating
  trigger, mounted once in the root layout

## Docs in this folder

- `decisions.md` — one numbered entry per real decision: why a
  self-service application (not just an admin "Users" panel) is the only
  path in, the priority-score formula and its weights, why the freeze is
  scoped to role (not to the moment of applying), the
  `app.mail.*`-vs-`spring.mail.*` choice, the action-suffix `POST
  .../review` instead of `PATCH`, and the two real environment-fragility
  findings from testing this (not code bugs).
- `explain_contributor_pipeline.md` — the three request/response shapes
  end to end, the priority-queue query shape (and why it's per-user
  aggregate queries + a Java sort, not one grouped SQL query), and the
  full approve → role flip → event → email code path.

## Test status

- `ContributionCrudIntegrationTest` — 4/4, real Postgres via
  Testcontainers, verified in isolation
- `BugReportCrudIntegrationTest` — 2/2, verified in isolation
- `ContributorApplicationCrudIntegrationTest` — 4/4, verified in
  isolation, including the priority-ordering/cap-at-5 test and the
  anti-cheat freeze test (a promoted CONTRIBUTOR's own solve produces no
  `problem_progress` row and no points ledger entry)
- Full-suite (`./mvnw test`, all 69 tests) attempted twice in the
  development sandbox; both runs broke ~24 minutes in from a Docker/
  resource interruption that killed every running container at once
  (including unrelated ones from a different project) — not a code
  regression, see decisions.md #6. Recommend a clean full-suite run on a
  machine/CI with more headroom before this ships for real.
- Verified live end-to-end against the actual `docker compose` stack
  (not just MockMvc): register → apply → shows in the admin's `/top`
  queue with real (zero) stats → approve → `GET /me` with a freshly
  re-logged-in token confirms `role: CONTRIBUTOR` → the approval's email
  log line appears in the `api` container's own logs, confirming the
  `AFTER_COMMIT` listener genuinely fires outside a test's rolled-back
  transaction (it structurally cannot fire inside one — see
  `explain_testing.md`'s own note on this, which
  `ContributorApplicationCrudIntegrationTest` never covers directly).
