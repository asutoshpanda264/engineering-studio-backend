package com.engineeringstudio.api.contributorapplication;

import java.util.List;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;

public interface ContributorApplicationRepository extends JpaRepository<ContributorApplication, UUID> {

    List<ContributorApplication> findByApplicantIdOrderByCreatedAtDesc(UUID applicantId);

    List<ContributorApplication> findByStatus(ContributorApplicationStatus status);

    boolean existsByApplicantIdAndStatus(UUID applicantId, ContributorApplicationStatus status);
}
