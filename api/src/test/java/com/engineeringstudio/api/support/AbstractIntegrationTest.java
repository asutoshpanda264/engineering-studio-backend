package com.engineeringstudio.api.support;

import org.junit.jupiter.api.AfterEach;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.cache.Cache;
import org.springframework.cache.CacheManager;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.transaction.annotation.Transactional;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Every feature's integration test suite extends this instead of each
 * declaring its own container — one real, ephemeral Postgres for the whole
 * test JVM run (Testcontainers reuses the same container instance across
 * every test class that extends this, since it's a single static field in
 * a shared base class), not a fresh container per class.
 *
 * @ServiceConnection is Spring Boot's own Testcontainers integration: it
 * reads the running container's JDBC URL/credentials and wires them into
 * `spring.datasource.*` automatically — no manual @DynamicPropertySource
 * boilerplate, and Flyway (which shares the same datasource config) runs
 * its real migrations against this real container on every test run. This
 * is deliberately NOT H2 or any in-memory fake — see decisions.md #4: the
 * concurrency/locking tests this project cares about most (points-award
 * races, in a later milestone) would pass falsely against H2's different
 * locking semantics.
 *
 * @Transactional here wraps every test METHOD in its own transaction that
 * rolls back at the end — standard Spring test isolation, and the reason
 * one test class's scenarios/users don't leak into another's assertions
 * (see ScenarioSeedMigrationTest's exact "32 scenarios" count, which would
 * otherwise silently break the moment any other test class ran first and
 * left its own published scenario rows behind). Flyway's migrations
 * (including the 32-scenario seed) run once at context startup, entirely
 * outside any test method's transaction, so they're unaffected — every
 * test method starts from that same seeded baseline and rolls back to it.
 * The one deliberate future exception: a genuine multi-threaded
 * concurrency test (points-award races, M5) needs two connections actually
 * racing, which a single wrapping transaction would prevent — that test
 * will override this at the class level rather than extend it as-is.
 * ProblemProgressConcurrencyTest and LeaderboardIntegrationTest (M6) both
 * take that same exception, for two different reasons — see each class's
 * own header comment.
 *
 * <p>REDIS is the same idea as POSTGRES, one container shared for the
 * whole test JVM run, added in M6 for `leaderboard.LeaderboardService`.
 * No dedicated Testcontainers Redis module exists (verified against
 * testcontainers-bom 2.0.5's own managed dependency list — Postgres,
 * Kafka, Mongo, ... but no `testcontainers-redis`), so this is a plain
 * `GenericContainer` instead of a typed one like `PostgreSQLContainer` —
 * Spring Boot's own `RedisContainerConnectionDetailsFactory` still
 * recognizes it and wires `spring.data.redis.*` automatically via
 * `@ServiceConnection`, the same as POSTGRES.
 *
 * <p>Through M7, most test classes never actually touched this container
 * at all (an `@TransactionalEventListener(phase = AFTER_COMMIT)` never
 * fires under this class's default rollback-per-test wrapping — see
 * LeaderboardIntegrationTest's own header). M8 changed that:
 * `scenario.ScenarioService`'s new `@Cacheable` reads write real,
 * NOT-rolled-back entries into Redis from basically any test that calls
 * `GET /scenarios`/`GET /scenarios/{id}` — Redis isn't a JPA resource, so
 * `@Transactional`'s rollback has no effect on it, the same fact
 * `LeaderboardIntegrationTest`'s own override exists to work around, just
 * showing up here as an IMPLICIT side effect of an ordinary read instead
 * of an explicit write this time. Left uncleared, a scenario cached by one
 * test method (possibly reflecting data that method's own transaction
 * then rolls back) would leak into every later test in this JVM run.
 * {@link #clearCaches()} below closes that gap for every test class that
 * extends this one, not just the ones that know to think about it.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.MOCK)
@AutoConfigureMockMvc
@Testcontainers
@ActiveProfiles("test")
@Transactional
public abstract class AbstractIntegrationTest {

    @Container
    @ServiceConnection
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>("postgres:16-alpine");

    @Container
    @ServiceConnection
    static final GenericContainer<?> REDIS =
            new GenericContainer<>(DockerImageName.parse("redis:7-alpine")).withExposedPorts(6379);

    @Autowired
    private CacheManager cacheManager;

    /** Runs after every test method (see class Javadoc) — every registered Spring Cache, cleared, so nothing a test cached (possibly reflecting data its own transaction then rolls back) survives into the next test. */
    @AfterEach
    void clearCaches() {
        for (String name : cacheManager.getCacheNames()) {
            Cache cache = cacheManager.getCache(name);
            if (cache != null) {
                cache.clear();
            }
        }
    }
}
