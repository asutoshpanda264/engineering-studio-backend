package com.engineeringstudio.api.points;

import java.util.List;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;

public interface PointsLedgerRepository extends JpaRepository<PointsLedgerEntry, UUID> {
    List<PointsLedgerEntry> findByUserIdOrderByCreatedAtDesc(UUID userId);
}
