package com.engineeringstudio.api.attempt;

import com.engineeringstudio.api.attempt.verify.VerifyResult;
import com.engineeringstudio.api.common.error.ApiException;
import com.engineeringstudio.api.common.json.JsonUtil;
import com.engineeringstudio.api.progress.ProblemProgressService;
import java.time.Clock;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

/**
 * A separate bean, deliberately — NOT methods on AttemptService itself.
 * AttemptService.submit calls the verify-service (a slow, potentially
 * failing HTTP call in Phase 4) with no surrounding transaction, so a
 * failure can commit a VERIFY_FAILED status write independently of the
 * failed attempt, instead of that write rolling back along with
 * everything else. Spring's @Transactional works via a proxy around the
 * bean — a method calling another @Transactional method on `this` inside
 * the same class bypasses that proxy entirely (a well-known Spring AOP
 * gotcha), so the only clean way to get "verify call, then EITHER of two
 * independent transactional writes" is two different beans. See
 * decisions.md.
 */
@Component
public class AttemptFinalizer {

    private final AttemptRepository attemptRepository;
    private final AttemptPauseIntervalRepository pauseIntervalRepository;
    private final ProblemProgressService problemProgressService;
    private final Clock clock;

    public AttemptFinalizer(
            AttemptRepository attemptRepository,
            AttemptPauseIntervalRepository pauseIntervalRepository,
            ProblemProgressService problemProgressService,
            Clock clock) {
        this.attemptRepository = attemptRepository;
        this.pauseIntervalRepository = pauseIntervalRepository;
        this.problemProgressService = problemProgressService;
        this.clock = clock;
    }

    /**
     * Also records points/progress (Phase 5) in this SAME transaction —
     * calling problemProgressService (a different bean, so this is a
     * normal cross-bean call, not the self-invocation problem this
     * class's own Javadoc describes) means an attempt can never end up
     * SUBMITTED with its points/progress silently unrecorded, or vice
     * versa: either both commit together or (on any exception) both roll
     * back together.
     */
    @Transactional
    public Attempt finalizeVerified(
            UUID attemptId, Integer elapsedSeconds, int totalPausedSeconds, String graphJson, VerifyResult result) {
        Attempt attempt = getOrThrow(attemptId);
        closeOpenPauseIntervalIfAny(attempt);

        attempt.setStatus(AttemptStatus.SUBMITTED);
        attempt.setSubmittedAt(clock.instant());
        attempt.setElapsedSeconds(elapsedSeconds);
        attempt.setTotalPausedSeconds(totalPausedSeconds);
        attempt.setPausedAt(null);
        attempt.setGraphSnapshot(graphJson);
        attempt.setVerifyMetrics(JsonUtil.toJson(result.metrics()));
        attempt.setVerifyEvaluation(JsonUtil.toJson(result.evaluation()));
        attempt.setVerifyScore(JsonUtil.toJson(result.score()));
        Attempt saved = attemptRepository.save(attempt);

        problemProgressService.recordOutcome(saved, saved.getScenario(), result);

        return saved;
    }

    /**
     * Deliberately touches nothing except `status` — no points/progress
     * were ever computed, so nothing else needs undoing. The attempt's
     * timing fields (startedAt, pausedAt, totalPausedSeconds) are left
     * exactly as they were, so a later resubmit computes elapsed time
     * fresh from real, unmodified state rather than from a half-applied
     * previous attempt.
     */
    @Transactional
    public void markVerifyFailed(UUID attemptId) {
        Attempt attempt = getOrThrow(attemptId);
        attempt.setStatus(AttemptStatus.VERIFY_FAILED);
        attemptRepository.save(attempt);
    }

    private void closeOpenPauseIntervalIfAny(Attempt attempt) {
        pauseIntervalRepository.findByAttemptIdAndResumedAtIsNull(attempt.getId())
                .ifPresent(interval -> {
                    interval.setResumedAt(clock.instant());
                    pauseIntervalRepository.save(interval);
                });
    }

    private Attempt getOrThrow(UUID attemptId) {
        return attemptRepository.findById(attemptId)
                .orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND, "Attempt not found: " + attemptId));
    }
}
