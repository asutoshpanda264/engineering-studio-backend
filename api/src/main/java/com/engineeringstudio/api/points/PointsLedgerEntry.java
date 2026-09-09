package com.engineeringstudio.api.points;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.Instant;
import java.util.UUID;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

/**
 * Append-only — never updated, never deleted. `attemptId` is UNIQUE at the
 * database level, which is what makes this the idempotency anchor for the
 * whole award-points operation: even if `ProblemProgressService` were ever
 * accidentally invoked twice for the same attempt, only one row could ever
 * exist for it. The running total (`points_ledger` summed by user, or this
 * entry's own `runningTotalForScenario`) is kept as a ledger rather than
 * only a mutable counter column specifically so a user's total is always
 * independently auditable/replayable — see decisions.md.
 */
@Entity
@Table(name = "points_ledger")
@Getter
@Setter
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class PointsLedgerEntry {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "user_id", nullable = false)
    private UUID userId;

    @Column(name = "scenario_id", nullable = false)
    private String scenarioId;

    @Column(name = "attempt_id", nullable = false, unique = true)
    private UUID attemptId;

    @Column(name = "delta_points", nullable = false)
    private int deltaPoints;

    @Column(name = "running_total_for_scenario", nullable = false)
    private int runningTotalForScenario;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @jakarta.persistence.PrePersist
    void onCreate() {
        createdAt = Instant.now();
    }
}
