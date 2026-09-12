package com.engineeringstudio.api.dailychallenge;

import com.engineeringstudio.api.auth.User;
import com.engineeringstudio.api.auth.UserRepository;
import com.engineeringstudio.api.common.error.ApiException;
import com.engineeringstudio.api.progress.ScenarioSolvedEvent;
import com.engineeringstudio.api.scenario.Scenario;
import com.engineeringstudio.api.scenario.ScenarioRepository;
import com.engineeringstudio.api.scenario.ScenarioStatus;
import java.time.Clock;
import java.time.LocalDate;
import java.time.format.DateTimeParseException;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ThreadLocalRandom;
import org.springframework.context.event.EventListener;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Deliberately a plain {@code @EventListener}, NOT
 * {@code @TransactionalEventListener(AFTER_COMMIT)} like
 * leaderboard.LeaderboardService (Phase 6) — the reason that phase needed
 * AFTER_COMMIT (Redis isn't a JPA resource, so it can't roll back with a
 * failed Postgres transaction) doesn't apply here: a completion row and a
 * streak update are both normal Postgres writes, and belong in the SAME
 * transaction as the ProblemProgress write that triggered them, for the
 * exact reason PointsLedgerEntry does (Phase 5) — a scenario marked SOLVED
 * with its streak/completion silently unrecorded, or vice versa, would be
 * a real data-integrity bug. A plain {@code @EventListener} fires
 * synchronously, inline, in whatever transaction is already open when
 * {@code publishEvent} is called — functionally a normal cross-bean call,
 * just decoupled through the event so `progress` never has to depend on
 * `dailychallenge` (see decisions.md).
 */
@Service
public class DailyChallengeService {

    private final DailyChallengeRepository dailyChallengeRepository;
    private final DailyChallengeCompletionRepository completionRepository;
    private final ScenarioRepository scenarioRepository;
    private final UserRepository userRepository;
    private final Clock clock;

    public DailyChallengeService(
            DailyChallengeRepository dailyChallengeRepository,
            DailyChallengeCompletionRepository completionRepository,
            ScenarioRepository scenarioRepository,
            UserRepository userRepository,
            Clock clock) {
        this.dailyChallengeRepository = dailyChallengeRepository;
        this.completionRepository = completionRepository;
        this.scenarioRepository = scenarioRepository;
        this.userRepository = userRepository;
        this.clock = clock;
    }

    /**
     * @Transactional here (and on {@link #getForDate}) deliberately —
     * {@link #getOrAutoAssign} can reach {@link DailyChallengeRepository#tryAutoAssign},
     * an {@code @Modifying} query, which (unlike a plain read query) needs
     * an ACTIVE transaction already open on the calling thread to run at
     * all — Spring Data JPA doesn't wrap `@Modifying` methods in their own
     * transaction automatically the way it does read queries (see
     * ProblemProgressConcurrencyTest's own comment on `ensureRowExists`
     * for the same fact, hit first in Phase 5). Both of these are public
     * entry points called straight from DailyChallengeController, which
     * has no transaction of its own — without this, the very first
     * `GET /daily-challenge/today` for a brand-new date would throw.
     */
    @Transactional
    public DailyChallenge getToday() {
        return getOrAutoAssign(today());
    }

    /** The server-authoritative "what day is it" — always derived from the injected Clock, never Instant.now()/LocalDate.now() directly, so it's controllable in tests via MutableClock. */
    public LocalDate today() {
        return LocalDate.now(clock);
    }

    /** Shared by both DailyChallengeController and AdminDailyChallengeController — one place for "what's a valid date in this API," one error message. */
    public static LocalDate parseDate(String raw) {
        try {
            return LocalDate.parse(raw);
        } catch (DateTimeParseException e) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "Invalid date, expected yyyy-MM-dd: " + raw);
        }
    }

    /** Any date up to and including today — a future date is refused rather than early-generated, so nobody can URL-guess tomorrow's pick early. See {@link #getToday} for why this is @Transactional. */
    @Transactional
    public DailyChallenge getForDate(LocalDate date) {
        if (date.isAfter(today())) {
            throw new ApiException(HttpStatus.NOT_FOUND, "No daily challenge exists for a future date");
        }
        return getOrAutoAssign(date);
    }

    @Transactional
    public void adminAssign(LocalDate date, String scenarioId) {
        Scenario scenario = scenarioRepository.findById(scenarioId)
                .orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND, "Scenario not found: " + scenarioId));
        if (scenario.getStatus() != ScenarioStatus.PUBLISHED) {
            throw new ApiException(HttpStatus.CONFLICT, "Only a published scenario can be a daily challenge");
        }
        dailyChallengeRepository.adminAssign(date, scenarioId, clock.instant());
    }

    public boolean hasUserCompletedToday(UUID userId) {
        return completionRepository.existsByUserIdAndChallengeDate(userId, today());
    }

    public List<DailyChallengeCompletion> historyForUser(UUID userId) {
        return completionRepository.findByUserIdOrderByChallengeDateDesc(userId);
    }

    @EventListener
    @Transactional
    public void onScenarioSolved(ScenarioSolvedEvent event) {
        DailyChallenge today = getOrAutoAssign(event.solvedOn());
        if (!today.getScenarioId().equals(event.scenarioId())) {
            return; // solved something real, just not today's designated challenge
        }

        int inserted = completionRepository.tryRecordCompletion(
                UUID.randomUUID(),
                event.userId(),
                event.solvedOn(),
                event.scenarioId(),
                event.attemptId(),
                event.mode().name(),
                clock.instant());
        if (inserted == 0) {
            return; // already completed today's challenge earlier today — streak already accounted for
        }

        applyStreak(event.userId(), event.solvedOn());
    }

    private void applyStreak(UUID userId, LocalDate solvedOn) {
        User user = userRepository.lockById(userId)
                .orElseThrow(() -> new IllegalStateException("User not found while applying streak: " + userId));

        // The completion insert above is the idempotency gate: this method
        // only ever runs once per (user, solvedOn), so lastSolveDate can
        // never already equal solvedOn here — either yesterday's date
        // (streak continues) or anything else, including null (streak
        // starts/restarts at 1).
        if (solvedOn.minusDays(1).equals(user.getLastSolveDate())) {
            user.setCurrentStreak(user.getCurrentStreak() + 1);
        } else {
            user.setCurrentStreak(1);
        }
        user.setLongestStreak(Math.max(user.getLongestStreak(), user.getCurrentStreak()));
        user.setLastSolveDate(solvedOn);
        userRepository.save(user);
    }

    private DailyChallenge getOrAutoAssign(LocalDate date) {
        return dailyChallengeRepository.findById(date).orElseGet(() -> {
            String scenarioId = pickRandomPublishedScenarioId();
            dailyChallengeRepository.tryAutoAssign(date, scenarioId, clock.instant());
            // Re-read rather than trust the id just picked: a concurrent
            // caller assigning the SAME never-before-seen date at the same
            // moment may have won the race with a DIFFERENT random pick —
            // ON CONFLICT DO NOTHING means only one insert actually lands,
            // and every caller must agree on whichever one that was.
            return dailyChallengeRepository.findById(date)
                    .orElseThrow(() -> new IllegalStateException(
                            "daily_challenges row missing immediately after tryAutoAssign for date=" + date));
        });
    }

    private String pickRandomPublishedScenarioId() {
        List<Scenario> published = scenarioRepository.findByStatus(ScenarioStatus.PUBLISHED);
        if (published.isEmpty()) {
            throw new IllegalStateException("No published scenarios exist to auto-assign as a daily challenge");
        }
        return published.get(ThreadLocalRandom.current().nextInt(published.size())).getId();
    }
}
