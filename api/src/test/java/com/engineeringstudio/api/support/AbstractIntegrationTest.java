package com.engineeringstudio.api.support;

import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.transaction.annotation.Transactional;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

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
}
