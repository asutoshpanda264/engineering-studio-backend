-- V5: daily_challenges + daily_challenge_completions
--
-- daily_challenges is deliberately keyed by the calendar date itself (no
-- surrogate id) — challenge_date is already a natural, globally-unique key
-- and nothing else ever needs to reference a row here by anything but the
-- date. One global challenge per day, not per-user.
--
-- daily_challenge_completions follows points_ledger's exact shape from
-- Phase 5: append-only, UNIQUE(user_id, challenge_date) is the idempotency
-- anchor an `INSERT ... ON CONFLICT DO NOTHING` relies on to answer "did
-- this user already complete today's challenge" race-safely, without a
-- separate existence check first. See masterdoc/phase-7-daily-challenge-streaks/
-- explain_dailychallenge.md.

CREATE TABLE daily_challenges (
    challenge_date  DATE PRIMARY KEY,
    scenario_id     VARCHAR(80) NOT NULL REFERENCES scenarios(id),
    -- AUTO: picked at random from PUBLISHED scenarios the first time the
    -- date was needed and nobody had assigned one yet. ADMIN: explicitly
    -- set via POST /admin/daily-challenge/{date}. Both are permanent once
    -- set — see decisions.md for why an ADMIN override of an already-AUTO
    -- day is allowed, and the known caveat that doing so after users have
    -- already completed that day's AUTO pick is a real, accepted edge case.
    assigned_by     VARCHAR(20) NOT NULL DEFAULT 'AUTO',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE daily_challenge_completions (
    id              UUID PRIMARY KEY,
    user_id         UUID NOT NULL REFERENCES users(id),
    challenge_date  DATE NOT NULL,
    scenario_id     VARCHAR(80) NOT NULL REFERENCES scenarios(id),
    attempt_id      UUID NOT NULL REFERENCES attempts(id),
    -- Denormalized from attempts.mode at completion time — kept here (not
    -- just joined from attempts) so a completion's history/calendar view
    -- never needs that join just to show "timed" vs "practice".
    mode            VARCHAR(20) NOT NULL,
    completed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, challenge_date)
);

CREATE INDEX idx_daily_challenge_completions_user ON daily_challenge_completions(user_id);
