package com.engineeringstudio.api.dailychallenge;

/**
 * AUTO — picked at random from PUBLISHED scenarios the first time a date
 * was needed and nobody had assigned one yet. ADMIN — explicitly set via
 * {@code POST /admin/daily-challenge/{date}}. See decisions.md: this
 * project has no dedicated "challenge setter" role or reminder-notification
 * pipeline yet, so AUTO is the only path that actually runs today; ADMIN
 * exists as the real, already-wired hook for when that workflow exists.
 */
public enum DailyChallengeAssignedBy {
    AUTO,
    ADMIN
}
