package com.engineeringstudio.api;

import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.context.annotation.Bean;
import org.testcontainers.containers.PostgreSQLContainer;

/**
 * Used only by TestEngineeringStudioApiApplication's `main` — Spring Boot's
 * "run locally against a real Testcontainers-provided database" dev
 * convenience (`./mvnw spring-boot:test-run`), NOT by the JUnit test suite
 * (which uses support.AbstractIntegrationTest instead, so there's exactly
 * one answer to "how do tests get a database"). Same Postgres image as
 * AbstractIntegrationTest, kept in sync deliberately — no reason for local
 * dev to run against a different Postgres version than CI does.
 */
@TestConfiguration(proxyBeanMethods = false)
class TestcontainersConfiguration {

	@Bean
	@ServiceConnection
	PostgreSQLContainer<?> postgresContainer() {
		return new PostgreSQLContainer<>("postgres:16-alpine");
	}

}
