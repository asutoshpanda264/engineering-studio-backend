-- V7: bug_reports
--
-- Any signed-in user (USER/CONTRIBUTOR/ADMIN) can file one; only an admin
-- reviews it. `route`/`user_agent` are auto-captured by the frontend at
-- submission time (current pathname + navigator.userAgent) — diagnostic
-- context, not something worth validating server-side.

CREATE TABLE bug_reports (
    id            UUID PRIMARY KEY,
    reporter_id   UUID NOT NULL REFERENCES users(id),
    description   TEXT NOT NULL,
    route         VARCHAR(500) NOT NULL,
    user_agent    VARCHAR(500) NOT NULL,
    status        VARCHAR(20) NOT NULL DEFAULT 'OPEN',
    admin_note    TEXT,
    resolved_at   TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_bug_reports_status ON bug_reports(status);
CREATE INDEX idx_bug_reports_reporter ON bug_reports(reporter_id);
