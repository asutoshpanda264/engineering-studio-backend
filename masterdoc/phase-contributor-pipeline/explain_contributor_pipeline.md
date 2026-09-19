# explain_contributor_pipeline.md — how the three pieces actually work

## Contribution — submit, queue, approve/reject

```
contributions
  id, contributor_id, category (QUESTION|POST|VLOG), title, body, link
  status (PENDING|APPROVED|REJECTED), points_awarded
  reviewed_at, reviewed_by, created_at, updated_at
```

```
POST /contributions            (CONTRIBUTOR or ADMIN)
  -> ContributionService.submit -> save(PENDING, pointsAwarded=0)

GET /contributions/pending      (ADMIN)
  -> findByStatus(PENDING)
  -> for each: totalApprovedPoints(contributorId)   -- SUM over that
                                                        contributor's own
                                                        APPROVED rows
  -> sort by that sum, descending, in Java (see decisions.md #3)

POST /contributions/{id}/approve   (ADMIN)
  -> assertPending
  -> status = APPROVED
  -> pointsAwarded = ContributionPointsCalculator.pointsFor(category)
  -> reviewedAt/reviewedBy set
```

`ContributionPointsCalculator` is a pure `switch` over the category enum
— no database access, no Spring — same shape as `points.PointsCalculator`.

## BugReport — file, list, review

```
bug_reports
  id, reporter_id, description, route, user_agent
  status (OPEN|IN_PROGRESS|RESOLVED), admin_note, resolved_at
```

`route`/`user_agent` are supplied by the *frontend* at submit time
(current pathname, `navigator.userAgent`) — the backend trusts and
stores them as-given, no server-side capture. `POST /bug-reports/{id}/review`
(not `PATCH` — see decisions.md #4) takes `{status, adminNote}` and sets
`resolvedAt` the first time (and only the first time) `status` becomes
`RESOLVED` — moving it back out of RESOLVED later doesn't clear that
timestamp, same "keep the historical fact" reasoning `Contribution.reviewedAt`
already follows.

## ContributorApplication — the actual path to CONTRIBUTOR

```
contributor_applications
  id, applicant_id, status (PENDING|APPROVED|REJECTED)
  reviewed_at, reviewed_by
  UNIQUE INDEX ... WHERE status = 'PENDING'   -- one pending app per user
```

```
POST /contributor-applications     (role: USER only — hasRole('USER'))
  -> existsByApplicantIdAndStatus(applicantId, PENDING)?
       yes -> 409 Conflict
       no  -> save(PENDING)

GET /contributor-applications/top   (ADMIN)
  -> findByStatus(PENDING)
  -> for each application:
       stats = ProblemProgressRepository.aggregateLeaderboardStats(applicantId)
                 -- the SAME query the real leaderboards are built from
                 -- (Phase 6) — solvedCount, totalPoints
       streak = User.currentStreak
       priority = ContributorApplicationPriority.score(solvedCount, totalPoints, streak)
                 -- totalPoints + solvedCount*20 + streak*10 (decisions.md #6)
  -> sort by priority, descending, in Java
  -> take the first 5 only (decisions.md #3, #6)
```

### Approval — the full commit-then-notify path

```
POST /contributor-applications/{id}/approve   (ADMIN)
  @Transactional
  1. getOrThrow(id), assertPending
  2. userRepository.lockById(applicantId)      -- PESSIMISTIC_WRITE,
                                                   same convention
                                                   dailychallenge's streak
                                                   read-modify-write uses
                                                   for a `users` row write
  3. applicant.role = CONTRIBUTOR; save
  4. application.status = APPROVED; reviewedAt/reviewedBy set; save
  5. eventPublisher.publishEvent(ContributorApplicationApprovedEvent(applicantId))
     -- queued, not sent yet — see below
  <transaction commits>
  6. EmailService.onContributorApplicationApproved fires
     (@TransactionalEventListener(phase = AFTER_COMMIT), decisions.md #9)
       -> userRepository.findById(applicantId)
       -> sendContributorApprovedEmail(user)
            -> host blank?  log "would have sent to <email>: [<subject>]", return
            -> host set?    build a JavaMailSenderImpl, actually send
```

A caller's very next `GET /me` **on their existing token** still shows
the old role — the JWT's role claim was fixed at issuance
(`phase-1-auth-rbac/industry.md`'s documented trade-off). A fresh
`POST /auth/login` (or a token refresh) is what picks up the change; the
frontend's `/contribute` page reflects this directly (see the frontend's
own explainDoc entry once it exists) by telling an approved-but-still-
on-a-stale-token user to sign out and back in.

### Why the score-freeze lives in `progress`, not here

`ContributorApplicationService` never touches `ProblemProgressService` —
the freeze (decisions.md #7) is a `progress`-package-owned rule that
reads `attempt.getUser().getRole()` fresh on every submit, so it applies
uniformly to *any* CONTRIBUTOR/ADMIN account regardless of how they got
that role (approved application, or the direct `UPDATE users SET role=...`
bootstrap path — see `README.md`), not just ones that went through this
specific flow.
