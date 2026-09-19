-- V8: contributor_applications
--
-- A plain USER applies once; an admin reviews it (see
-- ContributorApplicationService.listTopPending — only the top 5, ranked by
-- a priority score, are ever shown, not every pending row). Approval flips
-- the applicant's users.role to CONTRIBUTOR directly in the same
-- transaction — see ContributorApplicationService.approve.

CREATE TABLE contributor_applications (
    id             UUID PRIMARY KEY,
    applicant_id   UUID NOT NULL REFERENCES users(id),
    status         VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    reviewed_at    TIMESTAMPTZ,
    reviewed_by    UUID REFERENCES users(id),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_contributor_applications_status ON contributor_applications(status);
CREATE INDEX idx_contributor_applications_applicant ON contributor_applications(applicant_id);

-- One pending application per user at a time — a DB-level guarantee
-- alongside the service-layer check, same "defense in depth" reasoning
-- points_ledger's attempt_id UNIQUE constraint already follows.
CREATE UNIQUE INDEX idx_contributor_applications_one_pending_per_user
    ON contributor_applications(applicant_id) WHERE status = 'PENDING';
