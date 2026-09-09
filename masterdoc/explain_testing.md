# explain_testing.md — how the test infrastructure works

Cross-cutting, not tied to one phase: every phase's integration tests use
this same setup, so it lives here in `masterdoc/` rather than under a single
phase folder.

## `AbstractIntegrationTest` — the one shared base

`api/src/test/java/.../support/AbstractIntegrationTest.java` — every feature's
integration test suite extends this instead of declaring its own container.
It spins up one real, ephemeral Postgres via Testcontainers
(`postgres:16-alpine`) for the whole test class, and `@ServiceConnection`
(Spring Boot's own Testcontainers integration) wires the container's real
JDBC URL/credentials into `spring.datasource.*` automatically — no manual
`@DynamicPropertySource` boilerplate. Flyway (which shares that same
datasource config) runs its real migrations against this real container on
every test run, so a passing test suite is also proof the migrations
actually apply cleanly, not just that the Java code compiles.

Deliberately **not** H2 or mocked repositories: the concurrency-sensitive
logic this project cares about most (the points-award race condition, once
the `attempt`/`points` packages land) is exactly the kind of thing that
passes against a mock or an in-memory fake for the wrong reasons and is
subtly wrong against a real database's actual locking/transaction behavior
— H2 doesn't even implement the same locking semantics as Postgres.

`@AutoConfigureMockMvc` drives requests through the *actual* Spring Security
filter chain (`JwtAuthFilter` + `SecurityConfig` + `@PreAuthorize`), so a
test asserting "403 as USER, 200 as ADMIN" is proving the real wiring works,
not a mocked stand-in for it.

## Local dev, separately: `TestEngineeringStudioApiApplication`

Distinct from the JUnit test suite — this is Spring Boot's "run the real app
locally against a real Testcontainers-provided database" convenience
(`api/mvnw spring-boot:test-run`). It uses its own `TestcontainersConfiguration`
class (same Postgres image, `postgres:16-alpine`, kept in sync with
`AbstractIntegrationTest` deliberately — no reason local dev should run
against a different Postgres version than CI does), so there's exactly one
answer to "what Postgres version does this project test/run against,"
even though the wiring mechanism differs slightly between "run the app" and
"run the tests."

## Docker, and when it needs to be running

Testcontainers needs a live Docker daemon to start these containers at all
— nothing here works with Docker stopped. It's purely a testing/local-dev
time dependency; production never needs Docker.

**Containers clean themselves up automatically** once a test run finishes —
Testcontainers starts a small "Ryuk" reaper container alongside the real
one specifically to watch the test JVM and remove every container it
started the moment that JVM exits, success or failure. A normal
`api/mvnw test` run (whether it passes or fails) leaves nothing running
afterward.

The case where something *is* left running: the JVM gets killed abruptly
mid-test (a hard `Ctrl+C`, a crash, a forced terminal close) — Ryuk itself
can be interrupted before it finishes cleaning up, leaving an orphaned
Postgres container consuming RAM. On a machine with limited memory, that's
worth checking for periodically rather than assuming it never happens:

```sh
docker ps                      # see what's actually still running
docker container prune -f      # remove any stopped-but-not-yet-deleted containers
docker stop $(docker ps -q)    # if genuinely stuck: stop every running container
```

Since this project only needs Docker during an active test/dev-run session
— not continuously — the simplest way to avoid it silently eating memory
between work sessions is to **stop the whole daemon** when done testing for
the day, and start it again next time before running `api/mvnw test`:

```sh
sudo systemctl stop docker      # when done for the session
sudo systemctl start docker     # before the next test/dev-run
```

## A real, reproducible resource-pressure issue on this machine

This machine runs a separate project's full Docker stack alongside this one
(Kafka, several worker containers, its own Postgres/Redis — `route_llm`),
often for hours, on ~5.7GB total RAM. First hit while building Phase 2:
running the full `api/mvnw test` suite consistently — not randomly — failed
partway through with `Connection to localhost:XXXXX refused` /
`HikariPool ... Connection is not available`, always at the same point (the
first DB write of whichever test class ran third), while every individual
test class passed cleanly on its own. Confirmed via `docker ps`/`free -h`
this is sustained memory pressure (free memory dropping under ~500MB,
swap actively in use) building up over a few minutes of concurrent
JVM+Postgres+the other stack, not a bug in this project's code — the same
test class passes 100% of the time in isolation.

**Working approach until this machine has more headroom or `route_llm`
isn't running concurrently:** verify each milestone's tests by running that
milestone's test class(es) individually (`api/mvnw test -Dtest=ClassName`)
rather than defaulting to a full-suite run after every change; treat "does
the whole suite pass in one shot" as a periodic checkpoint, not a
per-change habit. Nothing about this is a compromise on correctness — a
class passing in isolation is fully verified, just not simultaneously with
everything else fighting for the same RAM.
