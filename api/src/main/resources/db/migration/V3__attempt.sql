-- V3: attempts + attempt_pause_intervals
--
-- elapsed_seconds is computed and stored at submit time from server-side
-- timestamps only (started_at, submitted_at, total_paused_seconds) — never
-- taken from a client-reported duration. See masterdoc/phase-3-attempt-state-machine/
-- decisions.md.

CREATE TABLE attempts (
    id                    UUID PRIMARY KEY,
    user_id               UUID NOT NULL REFERENCES users(id),
    scenario_id           VARCHAR(80) NOT NULL REFERENCES scenarios(id),
    scenario_version      INT NOT NULL,
    mode                  VARCHAR(20) NOT NULL,
    status                VARCHAR(20) NOT NULL DEFAULT 'IN_PROGRESS',
    started_at            TIMESTAMPTZ NOT NULL,
    submitted_at          TIMESTAMPTZ,
    total_paused_seconds  INT NOT NULL DEFAULT 0,
    -- Set while status = PAUSED (when the current, still-open pause began);
    -- NULL otherwise. Avoids a query against attempt_pause_intervals just
    -- to answer "is this attempt currently paused, and since when."
    paused_at             TIMESTAMPTZ,
    elapsed_seconds       INT,
    graph_snapshot        JSONB,
    verify_metrics        JSONB,
    verify_evaluation     JSONB,
    verify_score          JSONB,
    points_awarded        INT,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_attempts_user ON attempts(user_id);
CREATE INDEX idx_attempts_scenario ON attempts(scenario_id);
CREATE INDEX idx_attempts_user_status_open ON attempts(user_id, status) WHERE status IN ('IN_PROGRESS', 'PAUSED');

-- Audit trail of every pause/resume — attempts.total_paused_seconds is the
-- running total used for the elapsed-time calculation; this table exists
-- so that total is independently reconstructable/auditable later, not
-- because anything reads it directly today.
CREATE TABLE attempt_pause_intervals (
    id          UUID PRIMARY KEY,
    attempt_id  UUID NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
    paused_at   TIMESTAMPTZ NOT NULL,
    resumed_at  TIMESTAMPTZ
);

CREATE INDEX idx_pause_intervals_attempt ON attempt_pause_intervals(attempt_id);
