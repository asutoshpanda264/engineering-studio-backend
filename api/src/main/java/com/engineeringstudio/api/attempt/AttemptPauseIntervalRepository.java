package com.engineeringstudio.api.attempt;

import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;

public interface AttemptPauseIntervalRepository extends JpaRepository<AttemptPauseInterval, UUID> {
    /** The currently-open interval for an attempt, if it's paused right now — resumedAt IS NULL. */
    Optional<AttemptPauseInterval> findByAttemptIdAndResumedAtIsNull(UUID attemptId);
}
