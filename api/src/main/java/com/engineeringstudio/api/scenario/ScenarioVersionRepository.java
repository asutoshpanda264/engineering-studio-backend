package com.engineeringstudio.api.scenario;

import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;

public interface ScenarioVersionRepository extends JpaRepository<ScenarioVersion, UUID> {
    Optional<ScenarioVersion> findByScenarioIdAndVersion(String scenarioId, int version);
}
