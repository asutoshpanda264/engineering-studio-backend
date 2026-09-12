package com.engineeringstudio.api.dailychallenge;

import static org.assertj.core.api.Assertions.assertThat;

import com.engineeringstudio.api.attempt.AttemptMode;
import com.engineeringstudio.api.attempt.AttemptRepository;
import com.engineeringstudio.api.attempt.AttemptService;
import com.engineeringstudio.api.attempt.dto.StartAttemptRequest;
import com.engineeringstudio.api.attempt.dto.SubmitAttemptRequest;
import com.engineeringstudio.api.auth.Role;
import com.engineeringstudio.api.auth.User;
import com.engineeringstudio.api.auth.UserRepository;
import com.engineeringstudio.api.common.json.JsonUtil;
import com.engineeringstudio.api.points.PointsLedgerRepository;
import com.engineeringstudio.api.progress.ProblemProgressRepository;
import com.engineeringstudio.api.scenario.Scenario;
import com.engineeringstudio.api.scenario.ScenarioRepository;
import com.engineeringstudio.api.scenario.ScenarioStatus;
import com.engineeringstudio.api.support.AbstractIntegrationTest;
import com.engineeringstudio.api.support.FakeVerifyClient;
import com.engineeringstudio.api.support.MutableClock;
import com.engineeringstudio.api.support.TestServiceOverridesConfig;
import java.time.Duration;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CyclicBarrier;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Import;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/**
 * The Phase-7 analogue of ProblemProgressConcurrencyTest (Phase 5): two
 * DIFFERENT attempts at today's daily-challenge scenario, submitted as
 * close to simultaneously as two real threads can manage, must never both
 * increment the streak. Deliberately does NOT re-prove that
 * {@code @Lock(PESSIMISTIC_WRITE)} genuinely blocks a concurrent
 * reader — Phase 5's `pessimisticLockActuallyBlocksAConcurrentReader`
 * already proved that mechanism directly and deterministically, and
 * `UserRepository.lockById` uses the exact same mechanism. This test only
 * proves the end-to-end guarantee that mechanism is protecting here:
 * `daily_challenge_completions`'s `UNIQUE(user_id, challenge_date)` gates
 * entry to the streak update at most once per user per day, same
 * idempotency shape as PointsLedgerEntry.
 *
 * <p>Same {@code @Transactional(propagation = NOT_SUPPORTED)} exception as
 * that class, for the same reason: two real threads need genuinely
 * separate connections actually contending for the same row, not the
 * JUnit thread's single wrapping test transaction. Every row this test
 * creates is deleted explicitly in {@link #cleanUp()}.
 */
@Import(TestServiceOverridesConfig.class)
@Transactional(propagation = Propagation.NOT_SUPPORTED)
class DailyChallengeConcurrencyTest extends AbstractIntegrationTest {

    private static final String SCENARIO_ID = "dc-concurrency-scenario";
    private static final short DIFFICULTY = 3;

    @Autowired
    private AttemptService attemptService;

    @Autowired
    private AttemptRepository attemptRepository;

    @Autowired
    private MutableClock clock;

    @Autowired
    private FakeVerifyClient fakeVerifyClient;

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private ScenarioRepository scenarioRepository;

    @Autowired
    private PasswordEncoder passwordEncoder;

    @Autowired
    private ProblemProgressRepository problemProgressRepository;

    @Autowired
    private PointsLedgerRepository pointsLedgerRepository;

    @Autowired
    private DailyChallengeService dailyChallengeService;

    @Autowired
    private DailyChallengeRepository dailyChallengeRepository;

    @Autowired
    private DailyChallengeCompletionRepository completionRepository;

    private UUID userId;

    @BeforeEach
    void setUp() {
        fakeVerifyClient.reset();

        scenarioRepository.save(Scenario.builder()
                .id(SCENARIO_ID)
                .version(1)
                .status(ScenarioStatus.PUBLISHED)
                .title("Daily Challenge Concurrency Test Scenario")
                .difficulty(DIFFICULTY)
                .topics(JsonUtil.toJson(List.of("caching")))
                .story("A test scenario.")
                .startingEntities(JsonUtil.toJson(List.of()))
                .startingConnections(JsonUtil.toJson(List.of()))
                .trafficPattern(JsonUtil.toJson(Map.of("type", "constant", "rate", 10)))
                .durationMs(1000)
                .seed(1)
                .constraints(JsonUtil.toJson(List.of()))
                .hints(JsonUtil.toJson(List.of()))
                .learningGoals(JsonUtil.toJson(List.of()))
                .build());

        User user = userRepository.save(User.builder()
                .email("dc-racer@example.com")
                .passwordHash(passwordEncoder.encode("supersecret1"))
                .displayName("DC Racer")
                .role(Role.USER)
                .build());
        userId = user.getId();

        // A normal external call into the DailyChallengeService bean —
        // its own @Transactional opens a real transaction here,
        // independent of this test class's own NOT_SUPPORTED annotation
        // (which only governs the test method itself).
        dailyChallengeService.adminAssign(LocalDate.now(clock), SCENARIO_ID);
    }

    @AfterEach
    void cleanUp() {
        // No transactional rollback here (see class Javadoc) — every row
        // this test created is deleted explicitly, children before parents.
        completionRepository.findByUserIdOrderByChallengeDateDesc(userId).forEach(completionRepository::delete);
        dailyChallengeRepository.deleteById(LocalDate.now(clock));
        pointsLedgerRepository.findByUserIdOrderByCreatedAtDesc(userId).forEach(pointsLedgerRepository::delete);
        problemProgressRepository.findByUserId(userId).forEach(problemProgressRepository::delete);
        attemptRepository.findByUserIdOrderByCreatedAtDesc(userId).forEach(attemptRepository::delete);
        scenarioRepository.deleteById(SCENARIO_ID);
        userRepository.deleteById(userId);
    }

    @Test
    void twoSimultaneousSolvesOfTodaysChallengeNeverDoubleIncrementTheStreak() throws Exception {
        UUID attemptAId = attemptService.start(new StartAttemptRequest(SCENARIO_ID, AttemptMode.TIMED), userId).id();
        clock.advance(Duration.ofSeconds(10));
        UUID attemptBId = attemptService.start(new StartAttemptRequest(SCENARIO_ID, AttemptMode.TIMED), userId).id();
        clock.advance(Duration.ofSeconds(10));

        SubmitAttemptRequest submitRequest = new SubmitAttemptRequest(Map.of("nodes", List.of()));

        CyclicBarrier barrier = new CyclicBarrier(2);
        Runnable submitA = raceTask(barrier, () -> attemptService.submit(attemptAId, submitRequest, userId));
        Runnable submitB = raceTask(barrier, () -> attemptService.submit(attemptBId, submitRequest, userId));

        Thread threadA = new Thread(submitA, "dc-submit-a");
        Thread threadB = new Thread(submitB, "dc-submit-b");
        threadA.start();
        threadB.start();
        threadA.join();
        threadB.join();

        User user = userRepository.findById(userId).orElseThrow();
        assertThat(user.getCurrentStreak()).isEqualTo(1);
        assertThat(user.getLongestStreak()).isEqualTo(1);

        List<DailyChallengeCompletion> completions = completionRepository.findByUserIdOrderByChallengeDateDesc(userId);
        // The core guarantee: exactly one completion (and therefore
        // exactly one streak increment) ever recorded, never two — what
        // an unsynchronized race would produce is two rows and
        // currentStreak = 2.
        assertThat(completions).hasSize(1);
    }

    private static Runnable raceTask(CyclicBarrier barrier, Runnable action) {
        return () -> {
            try {
                barrier.await();
                action.run();
            } catch (Exception e) {
                throw new RuntimeException(e);
            }
        };
    }
}
