package com.engineeringstudio.api;

import com.engineeringstudio.api.support.AbstractIntegrationTest;
import org.junit.jupiter.api.Test;

/**
 * The barest possible check: does the whole Spring context start up
 * cleanly (every bean wires, every Flyway migration applies) against a
 * real Postgres? Extends AbstractIntegrationTest like every other
 * integration test in this project — Initializr originally generated its
 * own separate, one-off Testcontainers setup for just this file (a
 * different Postgres image, a different wiring mechanism); removed in
 * favor of the one shared base every feature's tests use, so there's a
 * single answer to "how does this project get a test database," not two.
 */
class EngineeringStudioApiApplicationTests extends AbstractIntegrationTest {

	@Test
	void contextLoads() {
	}

}
