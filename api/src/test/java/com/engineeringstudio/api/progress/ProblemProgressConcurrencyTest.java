package com.engineeringstudio.api.progress;

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
import com.engineeringstudio.api.points.PointsCalculator;
import com.engineeringstudio.api.points.PointsLedgerEntry;
import com.engineeringstudio.api.points.PointsLedgerRepository;
import com.engineeringstudio.api.scenario.Scenario;
import com.engineeringstudio.api.scenario.ScenarioRepository;
import com.engineeringstudio.api.scenario.ScenarioStatus;
import com.engineeringstudio.api.support.AbstractIntegrationTest;
import com.engineeringstudio.api.support.FakeVerifyClient;
import com.engineeringstudio.api.support.MutableClock;
import com.engineeringstudio.api.support.TestServiceOverridesConfig;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Import;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.transaction.annotation.Transactional;

/**
 * The single highest-value test in the whole plan: two DIFFERENT attempts
 * for the same (user, scenario), submitted as close to simultaneously as
 * two real threads can manage, must never both award their full points —
 * the loser's delta must come out to (at most) the difference against
 * whichever committed first, never a second full award on top.
 *
 * Deliberately overrides {@code @Transactional} back to
 * {@link Propagation#NOT_SUPPORTED} at the class level — AbstractIntegrationTest's
 * default per-test-method wrapping transaction runs on the JUnit thread
 * only; two new threads calling AttemptService.submit directly need their
 * own genuinely separate transactions/connections to actually contend for
 * problem_progress's row lock, and setup data (user/scenario/attempts)
 * has to be really committed and visible to those other connections
 * before the race starts, not sitting uncommitted in the outer test
 * transaction. This is exactly the exception AbstractIntegrationTest's
 * own class-level Javadoc already anticipated. Because nothing here
 * auto-rolls-back, every row created is deleted explicitly in
 * {@link #cleanUp()}.
 */
@Import(TestServiceOverridesConfig.class)
@Transactional(propagation = Propagation.NOT_SUPPORTED)
class ProblemProgressConcurrencyTest extends AbstractIntegrationTest {

    private static final String SCENARIO_ID = "concurrency-test-scenario";
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
    private PlatformTransactionManager transactionManager;

    private UUID userId;

    @BeforeEach
    void setUp() {
        fakeVerifyClient.reset();

        scenarioRepository.save(Scenario.builder()
                .id(SCENARIO_ID)
                .version(1)
                .status(ScenarioStatus.PUBLISHED)
                .title("Concurrency Test Scenario")
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
                .email("racer@example.com")
                .passwordHash(passwordEncoder.encode("supersecret1"))
                .displayName("Racer")
                .role(Role.USER)
                .build());
        userId = user.getId();
    }

    @AfterEach
    void cleanUp() {
        // No transactional rollback here (see class Javadoc) — every row
        // this test created is deleted explicitly, children before parents.
        pointsLedgerRepository.findByUserIdOrderByCreatedAtDesc(userId)
                .forEach(pointsLedgerRepository::delete);
        problemProgressRepository.findByUserId(userId).forEach(problemProgressRepository::delete);
        attemptRepository.findByUserIdOrderByCreatedAtDesc(userId).forEach(attemptRepository::delete);
        scenarioRepository.deleteById(SCENARIO_ID);
        userRepository.deleteById(userId);
    }

    @Test
    void twoSimultaneousSubmitsNeverDoubleAwardPoints() throws Exception {
        // Attempt A: starts first, ends up with 1000s elapsed.
        UUID attemptAId = attemptService.start(new StartAttemptRequest(SCENARIO_ID, AttemptMode.TIMED), userId).id();
        clock.advance(Duration.ofSeconds(50));
        // Attempt B: starts 50s later, ends up with 950s elapsed — both
        // submits happen at the same fixed "now" below, so whichever
        // attempt started earlier simply has a longer elapsed time.
        UUID attemptBId = attemptService.start(new StartAttemptRequest(SCENARIO_ID, AttemptMode.TIMED), userId).id();
        clock.advance(Duration.ofSeconds(950));

        int timeLimit = PointsCalculator.defaultTimeLimitSeconds(DIFFICULTY);
        int pointsA = PointsCalculator.totalPoints(DIFFICULTY, 3, 1000, timeLimit);
        int pointsB = PointsCalculator.totalPoints(DIFFICULTY, 3, 950, timeLimit);
        int expectedBest = Math.max(pointsA, pointsB);

        SubmitAttemptRequest submitRequest = new SubmitAttemptRequest(Map.of("nodes", List.of()));

        CyclicBarrier barrier = new CyclicBarrier(2);
        Runnable submitA = raceTask(barrier, () -> attemptService.submit(attemptAId, submitRequest, userId));
        Runnable submitB = raceTask(barrier, () -> attemptService.submit(attemptBId, submitRequest, userId));

        Thread threadA = new Thread(submitA, "submit-a");
        Thread threadB = new Thread(submitB, "submit-b");
        threadA.start();
        threadB.start();
        threadA.join();
        threadB.join();

        ProblemProgress progress = problemProgressRepository.findByUserIdAndScenarioId(userId, SCENARIO_ID)
                .orElseThrow();
        assertThat(progress.getBestPoints()).isEqualTo(expectedBest);
        assertThat(progress.getStatus()).isEqualTo(ProblemProgressStatus.SOLVED);

        List<PointsLedgerEntry> ledger = pointsLedgerRepository.findByUserIdOrderByCreatedAtDesc(userId);
        int totalAwarded = ledger.stream().mapToInt(PointsLedgerEntry::getDeltaPoints).sum();
        // The core guarantee: total ever awarded equals the single best
        // result, never pointsA + pointsB (which is what an unsynchronized
        // race would produce — both transactions reading the same stale
        // best_points=0 baseline and both awarding their full amount).
        assertThat(totalAwarded).isEqualTo(expectedBest);
        assertThat(ledger).hasSizeBetween(1, 2);
    }

    /**
     * The deterministic complement to the test above. Honest finding while
     * building this: a {@code CyclicBarrier}-synchronized start does NOT
     * reliably force two threads' database reads to genuinely overlap —
     * running {@link #twoSimultaneousSubmitsNeverDoubleAwardPoints} with
     * {@code @Lock(PESSIMISTIC_WRITE)} temporarily removed still passed 3/3
     * times, because one thread's whole read-write-commit cycle often
     * finishes before the other thread's read even begins (JVM thread
     * start-up and JPA/Hibernate first-call overhead easily exceed the
     * actual query time here) — so that test alone doesn't prove the lock
     * does anything, only that the happy path works.
     * <p>
     * This test proves the actual mechanism directly and deterministically
     * instead of hoping for lucky timing: one thread explicitly holds the
     * pessimistic lock open (via its own transaction, kept open with a
     * latch) while a second thread attempts the same lock — the second
     * call's wall-clock duration must be at least as long as the first
     * thread's hold time, proving it genuinely blocked rather than reading
     * a stale value while the first transaction was still in flight.
     */
    @Test
    void pessimisticLockActuallyBlocksAConcurrentReader() throws Exception {
        TransactionTemplate tx = new TransactionTemplate(transactionManager);
        // ensureRowExists is a @Modifying query — it needs an active
        // transaction of its own here, since (unlike ProblemProgressService
        // .recordOutcome, which is @Transactional) this test method itself
        // has none, by design (see class Javadoc).
        tx.executeWithoutResult(
                status -> problemProgressRepository.ensureRowExists(UUID.randomUUID(), userId, SCENARIO_ID, clock.instant()));

        CountDownLatch holderHasLock = new CountDownLatch(1);
        CountDownLatch releaseHolder = new CountDownLatch(1);
        long holdDurationMs = 400;

        Thread holder = new Thread(() -> tx.executeWithoutResult(status -> {
            problemProgressRepository.lockByUserIdAndScenarioId(userId, SCENARIO_ID);
            holderHasLock.countDown();
            awaitQuietly(releaseHolder);
        }));
        holder.start();
        assertThat(holderHasLock.await(5, TimeUnit.SECONDS)).as("holder thread acquired the lock").isTrue();

        AtomicLong waiterDurationMs = new AtomicLong();
        Thread waiter = new Thread(() -> {
            long start = System.currentTimeMillis();
            tx.executeWithoutResult(status -> problemProgressRepository.lockByUserIdAndScenarioId(userId, SCENARIO_ID));
            waiterDurationMs.set(System.currentTimeMillis() - start);
        });
        waiter.start();

        Thread.sleep(holdDurationMs);
        releaseHolder.countDown();
        holder.join(5000);
        waiter.join(5000);

        assertThat(waiterDurationMs.get())
                .as("second lock attempt should have blocked until the first released it")
                .isGreaterThanOrEqualTo(holdDurationMs - 50); // small tolerance for scheduling jitter
    }

    private static void awaitQuietly(CountDownLatch latch) {
        try {
            latch.await(5, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
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
