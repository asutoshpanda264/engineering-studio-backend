package com.engineeringstudio.api.contribution;

import java.util.List;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface ContributionRepository extends JpaRepository<Contribution, UUID> {

    List<Contribution> findByContributorIdOrderByCreatedAtDesc(UUID contributorId);

    List<Contribution> findByStatus(ContributionStatus status);

    /**
     * A contributor's total from approved contributions only — same
     * per-user aggregate shape as
     * {@code ProblemProgressRepository.aggregateLeaderboardStats}, not a
     * single query grouped across every contributor (this codebase
     * deliberately avoids that shape — see masterdoc phase-6 decisions.md).
     * {@code ContributionService.listPending} calls this once per
     * distinct submitter to build the admin queue's sort key.
     */
    @Query("""
            SELECT COALESCE(SUM(c.pointsAwarded), 0L)
            FROM Contribution c
            WHERE c.contributorId = :contributorId AND c.status = 'APPROVED'
            """)
    long totalApprovedPoints(@Param("contributorId") UUID contributorId);
}
