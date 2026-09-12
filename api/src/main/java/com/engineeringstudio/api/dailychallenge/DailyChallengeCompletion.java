package com.engineeringstudio.api.dailychallenge;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.Instant;
import java.time.LocalDate;
import java.util.UUID;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

/**
 * Append-only, one row per (user, challenge_date) at most — same shape as
 * PointsLedgerEntry (Phase 5): {@code UNIQUE(user_id, challenge_date)} is
 * the idempotency anchor {@link DailyChallengeCompletionRepository#tryRecordCompletion}
 * relies on. Written natively (see that repository), never via
 * {@code save()} — no lifecycle callback here either, same reasoning as
 * {@link DailyChallenge}.
 */
@Entity
@Table(name = "daily_challenge_completions")
@Getter
@Setter
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class DailyChallengeCompletion {

    @Id
    private UUID id;

    @Column(name = "user_id", nullable = false)
    private UUID userId;

    @Column(name = "challenge_date", nullable = false)
    private LocalDate challengeDate;

    @Column(name = "scenario_id", nullable = false)
    private String scenarioId;

    @Column(name = "attempt_id", nullable = false)
    private UUID attemptId;

    @Column(nullable = false)
    private String mode;

    @Column(name = "completed_at", nullable = false)
    private Instant completedAt;
}
