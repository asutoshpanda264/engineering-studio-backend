-- V2: scenarios + scenario_versions
--
-- Most of a scenario's body is stored as JSONB rather than normalized into
-- child tables: this data is read whole far more often than it's queried by
-- an individual field inside it (nobody filters scenarios by "constraints
-- containing a p95Latency threshold under 300"), and keeping it JSONB lets
-- the Java DTO mirror the frontend's existing Scenario TypeScript interface
-- field-for-field, which matters for the 32-scenario migration's fidelity.

CREATE TABLE scenarios (
    id                             VARCHAR(80) PRIMARY KEY,  -- reuses the frontend's existing slug ids
    version                        INT NOT NULL DEFAULT 1,
    status                         VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
    title                          VARCHAR(200) NOT NULL,
    difficulty                     SMALLINT NOT NULL CHECK (difficulty BETWEEN 1 AND 5),
    topics                         JSONB NOT NULL,
    suggested_time_limit_minutes   INT,
    story                          TEXT NOT NULL,
    starting_entities               JSONB NOT NULL,
    starting_connections            JSONB NOT NULL,
    traffic_pattern                 JSONB NOT NULL,
    duration_ms                    INT NOT NULL,
    seed                           INT NOT NULL,
    constraints                    JSONB NOT NULL,
    given_node_ids                  JSONB,
    locked_fields                   JSONB,
    budget_usd                     NUMERIC(10,2),
    requires_gated_tool_calls        BOOLEAN NOT NULL DEFAULT FALSE,
    hints                          JSONB NOT NULL,
    learning_goals                  JSONB NOT NULL,
    capacity_estimate               JSONB,
    reflection                     JSONB,
    optimal_solution                JSONB,
    created_by                     UUID REFERENCES users(id),
    created_at                     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_scenarios_status ON scenarios(status);
CREATE INDEX idx_scenarios_difficulty ON scenarios(difficulty);
CREATE INDEX idx_scenarios_topics_gin ON scenarios USING GIN (topics);
CREATE INDEX idx_scenarios_created_by ON scenarios(created_by);

-- Append-only version history. A surrogate UUID primary key (not the
-- composite (scenario_id, version) the plan sketched) — nothing else in
-- the schema needs to reference a specific version row by that composite
-- key, so a surrogate id is simpler in JPA (no @EmbeddedId ceremony) at no
-- real cost; the UNIQUE constraint still enforces the same invariant.
CREATE TABLE scenario_versions (
    id            UUID PRIMARY KEY,
    scenario_id   VARCHAR(80) NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
    version       INT NOT NULL,
    snapshot      JSONB NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (scenario_id, version)
);

CREATE INDEX idx_scenario_versions_scenario ON scenario_versions(scenario_id);
