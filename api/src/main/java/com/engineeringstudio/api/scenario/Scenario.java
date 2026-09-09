package com.engineeringstudio.api.scenario;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.UUID;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

/**
 * Every JSONB column is mapped as a plain `String` (raw JSON text), not a
 * typed Java object — Hibernate just passes it straight through to
 * Postgres via `@JdbcTypeCode(SqlTypes.JSON)`. Deliberately not relying on
 * Hibernate's own object&lt;-&gt;JSON marshalling for typed fields: this
 * project already has two different Jackson major versions on its
 * classpath for unrelated reasons (Spring's auto-configured Jackson 3.x
 * for HTTP, jjwt-jackson's classic Jackson 2.x for JWT signing — see
 * masterdoc/phase-1-auth-rbac/explain_boot4-migration.md), and which one
 * Hibernate's internal FormatMapper would pick given that isn't something
 * to bet application code on without verifying it. Explicit conversion via
 * `JsonUtil` (its own, deliberately separate, plain Jackson 2.x instance)
 * happens in `ScenarioMapper` instead — see that class.
 */
@Entity
@Table(name = "scenarios")
@Getter
@Setter
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class Scenario {

    @Id
    private String id;

    @Column(nullable = false)
    @Builder.Default
    private int version = 1;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    @Builder.Default
    private ScenarioStatus status = ScenarioStatus.DRAFT;

    @Column(nullable = false)
    private String title;

    @Column(nullable = false)
    private short difficulty;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(nullable = false, columnDefinition = "jsonb")
    private String topics;

    @Column(name = "suggested_time_limit_minutes")
    private Integer suggestedTimeLimitMinutes;

    @Column(nullable = false, columnDefinition = "text")
    private String story;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(nullable = false, columnDefinition = "jsonb")
    private String startingEntities;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(nullable = false, columnDefinition = "jsonb")
    private String startingConnections;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(nullable = false, columnDefinition = "jsonb")
    private String trafficPattern;

    @Column(nullable = false)
    private int durationMs;

    @Column(nullable = false)
    private int seed;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(nullable = false, columnDefinition = "jsonb")
    private String constraints;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(columnDefinition = "jsonb")
    private String givenNodeIds;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(columnDefinition = "jsonb")
    private String lockedFields;

    private BigDecimal budgetUsd;

    @Column(nullable = false)
    @Builder.Default
    private boolean requiresGatedToolCalls = false;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(nullable = false, columnDefinition = "jsonb")
    private String hints;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(nullable = false, columnDefinition = "jsonb")
    private String learningGoals;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(columnDefinition = "jsonb")
    private String capacityEstimate;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(columnDefinition = "jsonb")
    private String reflection;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(columnDefinition = "jsonb")
    private String optimalSolution;

    private UUID createdBy;

    @Column(nullable = false, updatable = false)
    private Instant createdAt;

    @Column(nullable = false)
    private Instant updatedAt;

    @jakarta.persistence.PrePersist
    void onCreate() {
        Instant now = Instant.now();
        createdAt = now;
        updatedAt = now;
    }

    @jakarta.persistence.PreUpdate
    void onUpdate() {
        updatedAt = Instant.now();
    }
}
