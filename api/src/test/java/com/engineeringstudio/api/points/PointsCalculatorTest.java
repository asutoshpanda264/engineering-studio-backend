package com.engineeringstudio.api.points;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.within;

import org.junit.jupiter.api.Test;

/**
 * No Spring context, no database — PointsCalculator is a pure function
 * class specifically so these run in milliseconds. Covers every star
 * tier, both speed-factor extremes at both difficulty extremes, the
 * null-elapsed (NO_PRESSURE) neutral case, and clamping.
 */
class PointsCalculatorTest {

    @Test
    void basePointsScalesLinearlyWithDifficulty() {
        assertThat(PointsCalculator.basePoints(1)).isEqualTo(20);
        assertThat(PointsCalculator.basePoints(5)).isEqualTo(100);
    }

    @Test
    void basePointsRejectsOutOfRangeDifficulty() {
        assertThatThrownBy(() -> PointsCalculator.basePoints(0)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> PointsCalculator.basePoints(6)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void starsMultiplierCoversEveryRealTierAndRejectsFour() {
        assertThat(PointsCalculator.starsMultiplier(0)).isEqualTo(0.0);
        assertThat(PointsCalculator.starsMultiplier(1)).isEqualTo(0.5);
        assertThat(PointsCalculator.starsMultiplier(2)).isEqualTo(0.75);
        assertThat(PointsCalculator.starsMultiplier(3)).isEqualTo(1.0);
        assertThat(PointsCalculator.starsMultiplier(5)).isEqualTo(1.5);
        assertThatThrownBy(() -> PointsCalculator.starsMultiplier(4)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void speedFactorSwingsHarderForHigherDifficulty() {
        // Instant solve (timeRatio = 0): bonus, bigger for harder scenarios.
        assertThat(PointsCalculator.speedFactor(1, 0, 100)).isCloseTo(1.06, within(1e-9));
        assertThat(PointsCalculator.speedFactor(5, 0, 100)).isCloseTo(1.30, within(1e-9));

        // Used the entire time limit (timeRatio = 1): penalty, bigger for harder scenarios.
        assertThat(PointsCalculator.speedFactor(1, 100, 100)).isCloseTo(0.94, within(1e-9));
        assertThat(PointsCalculator.speedFactor(5, 100, 100)).isCloseTo(0.70, within(1e-9));
    }

    @Test
    void speedFactorClampsBeyondTheTimeLimitInsteadOfGoingNegative() {
        // Took 3x the time limit — should clamp exactly as if timeRatio == 1, not swing further negative.
        assertThat(PointsCalculator.speedFactor(5, 300, 100)).isCloseTo(0.70, within(1e-9));
    }

    @Test
    void speedFactorIsNeutralWhenElapsedIsNull() {
        assertThat(PointsCalculator.speedFactor(5, null, 100)).isEqualTo(1.0);
    }

    @Test
    void totalPointsCombinesAllThreeFactorsAndRounds() {
        // difficulty 5, legendary (5 stars), instant solve: 100 * 1.5 * 1.3 = 195.0
        assertThat(PointsCalculator.totalPoints(5, 5, 0, 100)).isEqualTo(195);
        // difficulty 1, barely passed (1 star), used the full time: 20 * 0.5 * 0.94 = 9.4 -> 9
        assertThat(PointsCalculator.totalPoints(1, 1, 600, 600)).isEqualTo(9);
    }

    @Test
    void defaultTimeLimitMirrorsTheFrontendsPerDifficultyMinutes() {
        assertThat(PointsCalculator.defaultTimeLimitSeconds(1)).isEqualTo(10 * 60);
        assertThat(PointsCalculator.defaultTimeLimitSeconds(2)).isEqualTo(15 * 60);
        assertThat(PointsCalculator.defaultTimeLimitSeconds(3)).isEqualTo(20 * 60);
        assertThat(PointsCalculator.defaultTimeLimitSeconds(4)).isEqualTo(25 * 60);
        assertThat(PointsCalculator.defaultTimeLimitSeconds(5)).isEqualTo(30 * 60);
    }
}
