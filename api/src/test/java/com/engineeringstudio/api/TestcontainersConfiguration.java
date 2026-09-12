package com.engineeringstudio.api;

import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.context.annotation.Bean;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.utility.DockerImageName;

/**
 * Used only by TestEngineeringStudioApiApplication's `main` — Spring Boot's
 * "run locally against a real Testcontainers-provided database" dev
 * convenience (`./mvnw spring-boot:test-run`), NOT by the JUnit test suite
 * (which uses support.AbstractIntegrationTest instead, so there's exactly
 * one answer to "how do tests get a database"). Same Postgres and Redis
 * images as AbstractIntegrationTest, kept in sync deliberately — no reason
 * for local dev to run against different versions than CI does.
 *
 * <p>{@code redisContainer()}'s plain {@code @ServiceConnection} (no
 * {@code name}) — which works fine on AbstractIntegrationTest's own
 * `@Container` FIELD, discovered via JUnit's `@Testcontainers` extension —
 * fails here with `ConnectionDetailsNotFoundException: ... You may need to
 * add a 'name' to your @ServiceConnection annotation`. A real bug, only
 * ever caught the first time this class's Redis bean was actually
 * exercised (added in Phase 6, but every Phase 6-8 test run went through
 * the JUnit suite, never this interactive dev-run path, until connecting
 * the real frontend to a real running instance of this app required it).
 * The `@Bean`-method service-connection discovery path apparently can't
 * infer "this GenericContainer is Redis" from the image name alone the
 * way the JUnit-field path does — `name = "redis"` below is exactly what
 * the exception message itself named as the fix.
 */
@TestConfiguration(proxyBeanMethods = false)
class TestcontainersConfiguration {

	@Bean
	@ServiceConnection
	PostgreSQLContainer<?> postgresContainer() {
		return new PostgreSQLContainer<>("postgres:16-alpine");
	}

	@Bean
	@ServiceConnection(name = "redis")
	GenericContainer<?> redisContainer() {
		return new GenericContainer<>(DockerImageName.parse("redis:7-alpine")).withExposedPorts(6379);
	}

}
