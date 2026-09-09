package com.engineeringstudio.api.progress;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.UUID;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

/**
 * One row per (user, scenario) — the durable "how well has this user ever
 * done on this scenario" record. `best_*` fields are upgrade-only: they
 * only ever change to a strictly better value, never overwritten by a
 * worse or equal re-attempt. See decisions.md for the concurrency-safe
 * read-modify-write pattern that guarantees this under simultaneous
 * submits.
 */
@Entity
@Table(name = "problem_progress")
@Getter
@Setter
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class ProblemProgress {

    @Id
    private UUID id;

    @Column(name = "user_id", nullable = false)
    private UUID userId;

    @Column(name = "scenario_id", nullable = false)
    private String scenarioId;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    @Builder.Default
    private ProblemProgressStatus status = ProblemProgressStatus.ATTEMPTED;

    @Column(name = "best_stars", nullable = false)
    @Builder.Default
    private short bestStars = 0;

    @Column(name = "best_points", nullable = false)
    @Builder.Default
    private int bestPoints = 0;

    @Column(name = "best_composite")
    private BigDecimal bestComposite;

    @Column(name = "best_speed_factor")
    private BigDecimal bestSpeedFactor;

    @Column(name = "first_solved_at")
    private Instant firstSolvedAt;

    @Column(name = "last_attempt_at", nullable = false)
    private Instant lastAttemptAt;

    @Column(name = "solved_attempt_id")
    private UUID solvedAttemptId;
}
