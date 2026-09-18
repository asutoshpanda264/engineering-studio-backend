package com.engineeringstudio.api.bugreport;

import java.util.List;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;

public interface BugReportRepository extends JpaRepository<BugReport, UUID> {
    List<BugReport> findAllByOrderByCreatedAtDesc();
}
