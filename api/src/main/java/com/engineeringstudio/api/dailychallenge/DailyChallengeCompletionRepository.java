package com.engineeringstudio.api.dailychallenge;

import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface DailyChallengeCompletionRepository extends JpaRepository<DailyChallengeCompletion, UUID> {

    /**
     * `INSERT ... ON CONFLICT (user_id, challenge_date) DO NOTHING`,
     * returning the affected-row count (not void, unlike
     * DailyChallengeRepository's upserts) — DailyChallengeService reads
     * that count directly to know whether THIS call is the one that just
     * recorded the user's first completion for the day (1) or whether they
     * already had one (0), without a separate existence check first. Same
     * race-safe-idempotency shape as ProblemProgressRepository.ensureRowExists,
     * just with the "did I win" signal actually used instead of discarded.
     */
    @Modifying
    @Query(
            value = """
                    INSERT INTO daily_challenge_completions (id, user_id, challenge_date, scenario_id, attempt_id, mode, completed_at)
                    VALUES (:id, :userId, :challengeDate, :scenarioId, :attemptId, :mode, :now)
                    ON CONFLICT (user_id, challenge_date) DO NOTHING
                    """,
            nativeQuery = true)
    int tryRecordCompletion(
            @Param("id") UUID id,
            @Param("userId") UUID userId,
            @Param("challengeDate") LocalDate challengeDate,
            @Param("scenarioId") String scenarioId,
            @Param("attemptId") UUID attemptId,
            @Param("mode") String mode,
            @Param("now") Instant now);

    boolean existsByUserIdAndChallengeDate(UUID userId, LocalDate challengeDate);

    List<DailyChallengeCompletion> findByUserIdOrderByChallengeDateDesc(UUID userId);
}
