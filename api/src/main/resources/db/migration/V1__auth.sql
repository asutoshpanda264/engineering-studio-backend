-- V1: users + refresh_tokens
-- UUID primary keys are generated application-side by Hibernate
-- (GenerationType.UUID), not by a Postgres default/extension — see
-- decisions.md #7. So no DEFAULT clause on the id columns here; the app
-- always supplies one on insert.

CREATE TABLE users (
    id                 UUID PRIMARY KEY,
    email              VARCHAR(255) NOT NULL UNIQUE,
    password_hash      VARCHAR(255) NOT NULL,
    display_name       VARCHAR(100) NOT NULL,
    role               VARCHAR(20)  NOT NULL DEFAULT 'USER',
    current_streak     INT          NOT NULL DEFAULT 0,
    longest_streak     INT          NOT NULL DEFAULT 0,
    last_solve_date    DATE,
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX idx_users_role ON users(role);

CREATE TABLE refresh_tokens (
    id           UUID PRIMARY KEY,
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash   VARCHAR(255) NOT NULL UNIQUE,
    expires_at   TIMESTAMPTZ NOT NULL,
    revoked_at   TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);
