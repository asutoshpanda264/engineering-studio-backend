package com.engineeringstudio.api.points;

/**
 * The whole points formula, as one pure, stateless, static-method class —
 * no Spring dependency injection, no database access, nothing but
 * arithmetic. Deliberately kept this way so it's trivially unit-testable
 * in isolation (no Testcontainers, no Spring context — see
 * PointsCalculatorTest, which runs in milliseconds) and so the formula
 * itself is one thing to read top to bottom, not scattered across a
 * service class's control flow.
 *
 * <pre>
 * basePoints      = difficulty(1-5) × 20
 * starsMultiplier = 0★→0, 1★→0.5, 2★→0.75, 3★→1.0, 5★("legendary")→1.5
 * timeRatio       = elapsedSeconds / timeLimitSeconds, clamped [0,1]
 * difficultyW     = difficulty / 5
 * speedFactor     = 1 + difficultyW × (0.5 − timeRatio) × SWING
 * finalPoints     = round(basePoints × starsMultiplier × speedFactor)
 * </pre>
 *
 * See masterdoc/phase-5-points-and-progress/explain_points.md for the
 * reasoning behind the shape of this formula (why speed swings harder for
 * higher difficulty, why 4★ doesn't exist, ...) — this class is only the
 * "what," not the "why."
 */
public final class PointsCalculator {

    /** Tunable — how hard speed swings the final multiplier. Not exposed as config: changing it is a product/balance decision, not an environment one. */
    private static final double SWING = 0.6;

    private PointsCalculator() {
    }

    public static int basePoints(int difficulty) {
        requireValidDifficulty(difficulty);
        return difficulty * 20;
    }

    /**
     * 4★ deliberately doesn't exist — mirrors the frontend's own star
     * tiers (src/lib/scenarioScoring.ts's `ScenarioScore.stars: 0|1|2|3|5`,
     * where 5 means "legendary," beating the scenario's reference
     * solution) exactly, so a star count coming back from the
     * verify-service always maps onto a real tier here.
     */
    public static double starsMultiplier(int stars) {
        return switch (stars) {
            case 0 -> 0.0;
            case 1 -> 0.5;
            case 2 -> 0.75;
            case 3 -> 1.0;
            case 5 -> 1.5;
            default -> throw new IllegalArgumentException("Unsupported star tier: " + stars);
        };
    }

    /**
     * Null `elapsedSeconds` (NO_PRESSURE mode, or any non-timed context) —
     * returns a neutral 1.0. Callers awarding points for NO_PRESSURE
     * attempts shouldn't reach this at all (see ProblemProgressService),
     * but a neutral multiplier is the safe, honest answer if they do:
     * neither a bonus nor a penalty for a run that was never timed.
     */
    public static double speedFactor(int difficulty, Integer elapsedSeconds, int timeLimitSeconds) {
        requireValidDifficulty(difficulty);
        if (elapsedSeconds == null) {
            return 1.0;
        }
        double timeRatio = clamp(elapsedSeconds / (double) timeLimitSeconds, 0.0, 1.0);
        double difficultyWeight = difficulty / 5.0;
        return 1.0 + difficultyWeight * (0.5 - timeRatio) * SWING;
    }

    public static int totalPoints(int difficulty, int stars, Integer elapsedSeconds, int timeLimitSeconds) {
        double base = basePoints(difficulty);
        double multiplier = starsMultiplier(stars);
        double speed = speedFactor(difficulty, elapsedSeconds, timeLimitSeconds);
        return (int) Math.round(base * multiplier * speed);
    }

    /**
     * The frontend's own per-difficulty default (src/lib/timedChallenge.ts)
     * for a scenario that doesn't set `suggestedTimeLimitMinutes` —
     * mirrored here exactly so the same scenario gets the same effective
     * time limit whether the countdown shown to the student came from the
     * scenario's own field or this fallback.
     */
    public static int defaultTimeLimitSeconds(int difficulty) {
        int minutes = switch (difficulty) {
            case 1 -> 10;
            case 2 -> 15;
            case 3 -> 20;
            case 4 -> 25;
            case 5 -> 30;
            default -> throw new IllegalArgumentException("Unsupported difficulty: " + difficulty);
        };
        return minutes * 60;
    }

    private static double clamp(double value, double min, double max) {
        return Math.max(min, Math.min(max, value));
    }

    private static void requireValidDifficulty(int difficulty) {
        if (difficulty < 1 || difficulty > 5) {
            throw new IllegalArgumentException("Difficulty must be 1-5, got: " + difficulty);
        }
    }
}
