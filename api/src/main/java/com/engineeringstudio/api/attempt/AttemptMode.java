package com.engineeringstudio.api.attempt;

/**
 * TIMED — the competitive default: server-tracked clock, pause/resume
 * available, feeds points/leaderboards once those exist (Phase 5/6).
 * NO_PRESSURE — practice mode: no timer semantics at all (pause/resume
 * endpoints reject calls against a NO_PRESSURE attempt), zero points,
 * excluded from every leaderboard — but still eligible to mark a
 * scenario "solved" on the user's own profile once progress tracking
 * exists.
 */
public enum AttemptMode {
    TIMED,
    NO_PRESSURE
}
