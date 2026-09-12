package com.engineeringstudio.api.dailychallenge;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.Instant;
import java.time.LocalDate;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

/**
 * One global row per calendar date — not per user. `challengeDate` is the
 * primary key itself (no surrogate id): it's already a natural, unique
 * key, and nothing else ever needs to reference this row by anything but
 * the date.
 */
@Entity
@Table(name = "daily_challenges")
@Getter
@Setter
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class DailyChallenge {

    @Id
    @Column(name = "challenge_date")
    private LocalDate challengeDate;

    @Column(name = "scenario_id", nullable = false)
    private String scenarioId;

    @Enumerated(EnumType.STRING)
    @Column(name = "assigned_by", nullable = false)
    @Builder.Default
    private DailyChallengeAssignedBy assignedBy = DailyChallengeAssignedBy.AUTO;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    // No @PrePersist here, deliberately: every write to this table goes
    // through DailyChallengeRepository's native INSERT ... ON CONFLICT
    // queries (race-safety — see that repository's Javadoc), never a plain
    // JpaRepository.save(), so a lifecycle callback here would never fire.
    // This entity is written natively and read normally.
}
