package com.engineeringstudio.api.dailychallenge;

import java.time.Instant;
import java.time.LocalDate;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

/**
 * Both write paths here are native, race-safe upserts — never a plain
 * {@code save()} on a `new DailyChallenge(...)`, which would throw a
 * primary-key violation if two concurrent callers ever raced to assign the
 * SAME never-before-seen date at once (two users both triggering
 * "today's challenge" for the first time today, say):
 *
 * <ul>
 *   <li>{@link #tryAutoAssign} — `INSERT ... ON CONFLICT (challenge_date)
 *   DO NOTHING`, the exact same pattern as
 *   {@code ProblemProgressRepository.ensureRowExists} (Phase 5). Whichever
 *   caller's insert actually lands wins; every other concurrent caller's
 *   insert silently no-ops, and all of them re-read the same
 *   now-guaranteed-to-exist row afterward via {@link #findById}.</li>
 *   <li>{@link #adminAssign} — `INSERT ... ON CONFLICT (challenge_date) DO
 *   UPDATE`, a genuine upsert: a deliberate ADMIN action is allowed to
 *   overwrite an existing (AUTO-picked or previously ADMIN-set) row for
 *   that date. See decisions.md for the known caveat this creates if
 *   completions already exist for that date.</li>
 * </ul>
 *
 * Both are {@code @Modifying(clearAutomatically = true)} — a real,
 * verified-not-guessed finding while building this: without it, an
 * already-open persistence context that had previously loaded a
 * `DailyChallenge` for a given date (via {@link #findById}) keeps
 * returning that SAME cached, now-stale instance from a later
 * {@code findById} call for the same date, even after one of these native
 * queries changes the underlying row — Hibernate's first-level cache has
 * no way to know a native query touched an entity it's already tracking.
 * `clearAutomatically = true` evicts the persistence context right after
 * the native query runs, forcing the next read to hit the database.
 * `ProblemProgressRepository.ensureRowExists` (Phase 5) never needed this
 * because its own follow-up read is `@Lock(PESSIMISTIC_WRITE)` — a locking
 * query can't be satisfied from cache alone, it has to reach the database
 * regardless — but {@link #tryAutoAssign} and {@link #adminAssign} are
 * both followed by a plain {@code findById}, which can.
 */
public interface DailyChallengeRepository extends JpaRepository<DailyChallenge, LocalDate> {

    @Modifying(clearAutomatically = true)
    @Query(
            value = """
                    INSERT INTO daily_challenges (challenge_date, scenario_id, assigned_by, created_at)
                    VALUES (:date, :scenarioId, 'AUTO', :now)
                    ON CONFLICT (challenge_date) DO NOTHING
                    """,
            nativeQuery = true)
    void tryAutoAssign(@Param("date") LocalDate date, @Param("scenarioId") String scenarioId, @Param("now") Instant now);

    @Modifying(clearAutomatically = true)
    @Query(
            value = """
                    INSERT INTO daily_challenges (challenge_date, scenario_id, assigned_by, created_at)
                    VALUES (:date, :scenarioId, 'ADMIN', :now)
                    ON CONFLICT (challenge_date)
                    DO UPDATE SET scenario_id = EXCLUDED.scenario_id, assigned_by = 'ADMIN'
                    """,
            nativeQuery = true)
    void adminAssign(@Param("date") LocalDate date, @Param("scenarioId") String scenarioId, @Param("now") Instant now);
}
