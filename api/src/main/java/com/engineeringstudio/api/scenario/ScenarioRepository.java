package com.engineeringstudio.api.scenario;

import java.util.List;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;

public interface ScenarioRepository extends JpaRepository<Scenario, String> {
    List<Scenario> findByStatus(ScenarioStatus status);

    List<Scenario> findByStatusAndCreatedBy(ScenarioStatus status, UUID createdBy);
}
