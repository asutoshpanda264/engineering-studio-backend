-- V6: contributions
--
-- A contributor submits a QUESTION/POST/VLOG; an admin approves or
-- rejects it. Approval is a one-time, deterministic points award (see
-- ContributionPointsCalculator) recorded directly on the row itself
-- rather than a separate ledger table — unlike points_ledger
-- (V4__progress_and_points.sql), a contribution is never re-awarded or
-- re-scored after approval, so there's no recomputed/replayed history to
-- keep auditable beyond this one row's own reviewed_at/reviewed_by.

CREATE TABLE contributions (
    id               UUID PRIMARY KEY,
    contributor_id   UUID NOT NULL REFERENCES users(id),
    category         VARCHAR(20) NOT NULL,
    title            VARCHAR(200) NOT NULL,
    body             TEXT NOT NULL,
    link             VARCHAR(500),
    status           VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    points_awarded   INT NOT NULL DEFAULT 0,
    reviewed_at      TIMESTAMPTZ,
    reviewed_by      UUID REFERENCES users(id),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_contributions_status ON contributions(status);
CREATE INDEX idx_contributions_contributor ON contributions(contributor_id);
