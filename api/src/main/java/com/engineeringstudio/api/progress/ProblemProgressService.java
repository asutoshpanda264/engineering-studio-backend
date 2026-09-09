package com.engineeringstudio.api.progress;

import com.engineeringstudio.api.attempt.Attempt;
import com.engineeringstudio.api.attempt.AttemptMode;
import com.engineeringstudio.api.attempt.verify.VerifyResult;
import com.engineeringstudio.api.points.PointsCalculator;
import com.engineeringstudio.api.points.PointsLedgerEntry;
import com.engineeringstudio.api.points.PointsLedgerRepository;
import com.engineeringstudio.api.scenario.Scenario;
import java.math.BigDecimal;
import java.time.Clock;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Called from AttemptFinalizer.finalizeVerified — see decisions.md — as
 * part of the SAME transaction that marks an Attempt SUBMITTED, so a
 * progress/points write can never succeed while the attempt itself fails
 * to persist, or vice versa.
 */
@Service
public class ProblemProgressService {

    private final ProblemProgressRepository problemProgressRepository;
    private final PointsLedgerRepository pointsLedgerRepository;
    private final Clock clock;

    public ProblemProgressService(
            ProblemProgressRepository problemProgressRepository,
            PointsLedgerRepository pointsLedgerRepository,
            Clock clock) {
        this.problemProgressRepository = problemProgressRepository;
        this.pointsLedgerRepository = pointsLedgerRepository;
        this.clock = clock;
    }

    @Transactional
    public void recordOutcome(Attempt attempt, Scenario scenario, VerifyResult verifyResult) {
        UUID userId = attempt.getUser().getId();
        String scenarioId = scenario.getId();
        Instant now = clock.instant();

        // Race-safe existence-then-lock pair — see
        // ProblemProgressRepository's own Javadoc for why this is two
        // steps, not one.
        problemProgressRepository.ensureRowExists(UUID.randomUUID(), userId, scenarioId, now);
        ProblemProgress progress = problemProgressRepository.lockByUserIdAndScenarioId(userId, scenarioId)
                .orElseThrow(() -> new IllegalStateException(
                        "problem_progress row missing immediately after ensureRowExists for user=" + userId
                                + " scenario=" + scenarioId));

        progress.setLastAttemptAt(now);

        boolean gatesPassed = extractGatesPassed(verifyResult.score());
        if (!gatesPassed) {
            // ATTEMPTED (or stays SOLVED, if it already was — a worse
            // re-attempt never demotes a scenario back to unsolved).
            problemProgressRepository.save(progress);
            return;
        }

        int stars = extractStars(verifyResult.score());
        double composite = extractComposite(verifyResult.score());

        boolean firstEverSolve = progress.getStatus() != ProblemProgressStatus.SOLVED;
        progress.setStatus(ProblemProgressStatus.SOLVED);
        if (firstEverSolve) {
            progress.setFirstSolvedAt(now);
        }

        if (attempt.getMode() != AttemptMode.TIMED) {
            // NO_PRESSURE: marks solved, contributes zero points, never
            // upgrades best_* — see phase-3's mode design and
            // decisions.md here for why.
            problemProgressRepository.save(progress);
            return;
        }

        int difficulty = scenario.getDifficulty();
        int timeLimitSeconds = scenario.getSuggestedTimeLimitMinutes() != null
                ? scenario.getSuggestedTimeLimitMinutes() * 60
                : PointsCalculator.defaultTimeLimitSeconds(difficulty);

        int candidatePoints = PointsCalculator.totalPoints(
                difficulty, stars, attempt.getElapsedSeconds(), timeLimitSeconds);
        int delta = Math.max(0, candidatePoints - progress.getBestPoints());

        if (delta > 0) {
            progress.setBestPoints(candidatePoints);
            progress.setBestStars((short) stars);
            progress.setBestComposite(BigDecimal.valueOf(composite));
            progress.setBestSpeedFactor(BigDecimal.valueOf(
                    PointsCalculator.speedFactor(difficulty, attempt.getElapsedSeconds(), timeLimitSeconds)));
            progress.setSolvedAttemptId(attempt.getId());
            problemProgressRepository.save(progress);

            pointsLedgerRepository.save(PointsLedgerEntry.builder()
                    .userId(userId)
                    .scenarioId(scenarioId)
                    .attemptId(attempt.getId())
                    .deltaPoints(delta)
                    .runningTotalForScenario(candidatePoints)
                    .build());
        } else {
            // Re-solved at equal-or-worse quality: no upgrade, no new
            // points, no ledger entry — see masterdoc points formula
            // design ("awarded only on improvement").
            problemProgressRepository.save(progress);
        }
    }

    private static boolean extractGatesPassed(Map<String, Object> score) {
        return score.get("gatesPassed") instanceof Boolean b && b;
    }

    private static int extractStars(Map<String, Object> score) {
        if (score.get("stars") instanceof Number n) {
            return n.intValue();
        }
        throw new IllegalStateException("verify result missing a numeric 'stars' field");
    }

    private static double extractComposite(Map<String, Object> score) {
        if (score.get("composite") instanceof Number n) {
            return n.doubleValue();
        }
        throw new IllegalStateException("verify result missing a numeric 'composite' field");
    }
}
