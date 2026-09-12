package com.engineeringstudio.api.auth;

import jakarta.persistence.LockModeType;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

/**
 * Spring Data JPA generates the implementation of this interface at runtime —
 * `findByEmail` is "query derivation": Spring parses the method name and
 * builds the JPQL query from it, no SQL/JPQL string written by us. We only
 * hand-write a query when derivation can't express it.
 */
public interface UserRepository extends JpaRepository<User, UUID> {
    Optional<User> findByEmail(String email);

    boolean existsByEmail(String email);

    /**
     * `@Lock(PESSIMISTIC_WRITE)` read of a single user, for
     * dailychallenge.DailyChallengeService's streak read-modify-write — the
     * same pattern as ProblemProgressRepository.lockByUserIdAndScenarioId
     * (Phase 5), just over `users` instead of `problem_progress`. A
     * DIFFERENT, explicitly-named method from the plain
     * {@link JpaRepository#findById}, so a normal profile read (`GET /me`)
     * never takes a write lock it has no reason to hold.
     */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("SELECT u FROM User u WHERE u.id = :id")
    Optional<User> lockById(@Param("id") UUID id);
}
