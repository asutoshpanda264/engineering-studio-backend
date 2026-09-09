-- V4: problem_progress + points_ledger
--
-- problem_progress uses a surrogate UUID primary key + a UNIQUE(user_id,
-- scenario_id) constraint, not a composite PK — same simplification
-- reasoning as scenario_versions (see scenario/decisions.md #3): nothing
-- else references this row by a composite key, and a surrogate id avoids
-- @EmbeddedId ceremony while the UNIQUE constraint enforces the identical
-- invariant. It's also what makes Spring Data JPA's @Lock(PESSIMISTIC_WRITE)
-- on a plain findByUserIdAndScenarioId query straightforward — see
-- phase-5-points-and-progress/decisions.md.

CREATE TABLE problem_progress (
    id                  UUID PRIMARY KEY,
    user_id             UUID NOT NULL REFERENCES users(id),
    scenario_id         VARCHAR(80) NOT NULL REFERENCES scenarios(id),
    status              VARCHAR(20) NOT NULL DEFAULT 'ATTEMPTED',  -- ATTEMPTED | SOLVED
    best_stars          SMALLINT NOT NULL DEFAULT 0,
    best_points         INT NOT NULL DEFAULT 0,
    best_composite      NUMERIC(7,6),
    best_speed_factor   NUMERIC(7,5),                              -- only ever set from a TIMED solve
    first_solved_at     TIMESTAMPTZ,                                -- set once, on first-ever ATTEMPTED -> SOLVED transition
    last_attempt_at     TIMESTAMPTZ NOT NULL,
    solved_attempt_id   UUID REFERENCES attempts(id),                -- which attempt produced best_points
    UNIQUE (user_id, scenario_id)
);

CREATE INDEX idx_problem_progress_user_status ON problem_progress(user_id, status);

-- Append-only. attempt_id UNIQUE is the idempotency anchor described in
-- phase-5's decisions.md — an attempt can generate at most one ledger row
-- ever, even under a retried/duplicate submit call.
CREATE TABLE points_ledger (
    id                          UUID PRIMARY KEY,
    user_id                     UUID NOT NULL REFERENCES users(id),
    scenario_id                 VARCHAR(80) NOT NULL REFERENCES scenarios(id),
    attempt_id                  UUID NOT NULL UNIQUE REFERENCES attempts(id),
    delta_points                INT NOT NULL CHECK (delta_points > 0),
    running_total_for_scenario  INT NOT NULL,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_points_ledger_user ON points_ledger(user_id);
