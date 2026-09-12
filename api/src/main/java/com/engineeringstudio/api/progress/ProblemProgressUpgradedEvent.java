package com.engineeringstudio.api.progress;

import java.util.UUID;

/**
 * Published exactly once per genuine {@code best_points} upgrade — the
 * same condition (`delta > 0` on a TIMED attempt) that also writes a
 * {@code PointsLedgerEntry}, in ProblemProgressService.recordOutcome.
 * Deliberately carries only {@code userId}: the one thing every current
 * and future listener needs is "recompute this user's derived state," not
 * the details of what changed — a listener that needs more (which
 * scenario, what the new best was) re-reads problem_progress itself
 * rather than this event growing a payload only it needs.
 *
 * <p>Currently consumed by {@code leaderboard.LeaderboardService} (Phase
 * 6). Almost certainly also relevant to streaks (Phase 7) once that
 * package exists — one more reason not to shape this event around
 * leaderboard-specific vocabulary.
 */
public record ProblemProgressUpgradedEvent(UUID userId) {
}
