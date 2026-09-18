# Multi-stage build: compile with a full Maven+JDK image, run on a slim JRE.
#
# Uses the base image's own `mvn` (not `./mvnw`) — the wrapper's job is
# pinning a Maven version for host machines that might not have one; this
# image already ships a compatible Maven, so invoking it directly avoids
# needing wget/curl/unzip in the build stage just to download the wrapper's
# own distribution.

FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /build

# Copy just the POM first so dependency resolution is its own cached layer —
# an unchanged pom.xml means `mvn dependency:go-offline` is skipped on
# rebuilds triggered only by source changes.
COPY pom.xml .
RUN mvn -B dependency:go-offline

COPY src src
# Tests need Testcontainers (real Postgres/Redis), which means Docker-in-Docker
# here — this project's own test suite already runs via `./mvnw test`/CI
# outside the image build. Skipped here so `docker compose up --build` stays
# a fast, deterministic image build, not a second place the test suite runs.
RUN mvn -B -DskipTests package

FROM eclipse-temurin:21-jre-alpine
WORKDIR /app

RUN addgroup -S spring && adduser -S spring -G spring
COPY --from=build /build/target/*.jar app.jar
USER spring:spring

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=5s --retries=10 --start-period=30s \
  CMD wget -qO- http://localhost:8080/actuator/health || exit 1

ENTRYPOINT ["java", "-jar", "app.jar"]
