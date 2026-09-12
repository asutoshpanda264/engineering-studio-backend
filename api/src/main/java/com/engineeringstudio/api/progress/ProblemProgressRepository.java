package com.engineeringstudio.api.progress;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import jakarta.persistence.LockModeType;

/**
 * The concurrency-safe read-modify-write pattern for problem_progress
 * lives across these two methods together — see decisions.md for the full
 * reasoning:
 *
 * 1. {@link #ensureRowExists} — a native `INSERT ... ON CONFLICT DO
 *    NOTHING`. Postgres row-level locking can't protect a row that
 *    doesn't exist yet, so two concurrent FIRST-ever attempts on the same
 *    (user, scenario) could otherwise both try to insert and one would
 *    fail with a unique-violation. `ON CONFLICT DO NOTHING` makes this
 *    step itself race-safe and idempotent — call it every time, whether
 *    the row exists or not.
 * 2. {@link #lockByUserIdAndScenarioId} — `@Lock(PESSIMISTIC_WRITE)`
 *    (Postgres `SELECT ... FOR UPDATE`). Once the row is guaranteed to
 *    exist, this locks it for the rest of the transaction — a second,
 *    concurrent transaction calling this same method for the same row
 *    blocks until the first commits, then reads the ALREADY-UPDATED
 *    `best_points` rather than a stale value, so its own delta
 *    computation is correct instead of racing.
 *
 * Deliberately a DIFFERENT, explicitly-named method from the plain
 * {@link #findByUserIdAndScenarioId} used for read-only display (the
 * `GET /progress/scenarios/{id}` endpoint) — taking a write lock just to
 * render a user's own progress page would needlessly contend with
 * concurrent submits for no reason, and a pessimistic lock also requires
 * an active transaction to hold it, which a plain read endpoint has no
 * other reason to open.
 */
public interface ProblemProgressRepository extends JpaRepository<ProblemProgress, UUID> {

    @Modifying
    @Query(
            value = """
                    INSERT INTO problem_progress (id, user_id, scenario_id, status, best_stars, best_points, last_attempt_at)
                    VALUES (:id, :userId, :scenarioId, 'ATTEMPTED', 0, 0, :now)
                    ON CONFLICT (user_id, scenario_id) DO NOTHING
                    """,
            nativeQuery = true)
    void ensureRowExists(
            @Param("id") UUID id,
            @Param("userId") UUID userId,
            @Param("scenarioId") String scenarioId,
            @Param("now") Instant now);

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("SELECT p FROM ProblemProgress p WHERE p.userId = :userId AND p.scenarioId = :scenarioId")
    Optional<ProblemProgress> lockByUserIdAndScenarioId(@Param("userId") UUID userId, @Param("scenarioId") String scenarioId);

    Optional<ProblemProgress> findByUserIdAndScenarioId(UUID userId, String scenarioId);

    List<ProblemProgress> findByUserId(UUID userId);

    /**
     * The single source-of-truth aggregate leaderboard.LeaderboardService
     * recomputes from, on every refresh — see decisions.md's "recompute
     * and SET, never increment" entry. Filtered on
     * {@code bestSpeedFactor IS NOT NULL} rather than
     * {@code status = SOLVED} deliberately: that field is set on ONLY the
     * TIMED, delta&gt;0 branch of recordOutcome, so this one condition
     * already excludes NO_PRESSURE solves — which AttemptMode's own
     * Javadoc says must be "excluded from every leaderboard" — without a
     * separate mode check here. SQL's AVG ignores NULLs on its own, so
     * every row this WHERE clause admits has a real speed factor to
     * average; a user with zero qualifying rows gets an aggregate with
     * {@code solvedCount = 0} and a null {@code avgSpeedFactor}.
     */
    @Query("""
            SELECT COUNT(p) AS solvedCount,
                   COALESCE(SUM(p.bestPoints), 0L) AS totalPoints,
                   AVG(p.bestSpeedFactor) AS avgSpeedFactor
            FROM ProblemProgress p
            WHERE p.userId = :userId AND p.bestSpeedFactor IS NOT NULL
            """)
    ProblemProgressLeaderboardStats aggregateLeaderboardStats(@Param("userId") UUID userId);

    /** Every user who has ever earned a leaderboard-eligible solve — the full membership list leaderboard.LeaderboardService.rebuildAll() replays. */
    @Query("SELECT DISTINCT p.userId FROM ProblemProgress p WHERE p.bestSpeedFactor IS NOT NULL")
    List<UUID> findDistinctUserIdsWithLeaderboardEligibleSolves();
}
