package com.engineeringstudio.api.progress;

import com.engineeringstudio.api.attempt.AttemptMode;
import java.time.LocalDate;
import java.util.UUID;

/**
 * Published from ProblemProgressService.recordOutcome whenever an
 * attempt's `gatesPassed` is true — unconditionally, regardless of
 * {@link AttemptMode} or whether this was a genuine `best_points` upgrade.
 * Deliberately a DIFFERENT, broader event than {@link ProblemProgressUpgradedEvent}
 * (which fires only on TIMED + delta&gt;0): dailychallenge.DailyChallengeService
 * (Phase 7) needs to know about EVERY passing solve of today's challenge,
 * in any mode, per the product decision that a streak stays alive on a
 * NO_PRESSURE solve too (leaderboard eligibility does not — see
 * AttemptMode's own Javadoc). Two events with two precise, non-overlapping
 * meanings, each named for exactly the fact it represents, rather than one
 * generic event every listener has to re-filter for its own rule.
 *
 * <p>{@code solvedOn} is computed by the publisher from its own injected
 * {@code Clock} ({@code LocalDate.now(clock)}) — the single
 * server-authoritative notion of "what day is it," never derived
 * independently by a listener from a raw Instant + its own timezone
 * assumption.
 */
public record ScenarioSolvedEvent(UUID userId, String scenarioId, UUID attemptId, AttemptMode mode, LocalDate solvedOn) {
}
