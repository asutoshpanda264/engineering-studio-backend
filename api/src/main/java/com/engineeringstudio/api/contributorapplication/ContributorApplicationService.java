package com.engineeringstudio.api.contributorapplication;

import com.engineeringstudio.api.auth.Role;
import com.engineeringstudio.api.auth.User;
import com.engineeringstudio.api.auth.UserRepository;
import com.engineeringstudio.api.common.error.ApiException;
import com.engineeringstudio.api.contributorapplication.dto.ContributorApplicationResponse;
import com.engineeringstudio.api.contributorapplication.dto.TopContributorApplicationResponse;
import com.engineeringstudio.api.progress.ProblemProgressLeaderboardStats;
import com.engineeringstudio.api.progress.ProblemProgressRepository;
import java.time.Instant;
import java.util.Comparator;
import java.util.List;
import java.util.UUID;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class ContributorApplicationService {

    private static final int TOP_N = 5;

    private final ContributorApplicationRepository applicationRepository;
    private final UserRepository userRepository;
    private final ProblemProgressRepository problemProgressRepository;
    private final ContributorApplicationMapper mapper;
    private final ApplicationEventPublisher eventPublisher;

    public ContributorApplicationService(
            ContributorApplicationRepository applicationRepository,
            UserRepository userRepository,
            ProblemProgressRepository problemProgressRepository,
            ContributorApplicationMapper mapper,
            ApplicationEventPublisher eventPublisher) {
        this.applicationRepository = applicationRepository;
        this.userRepository = userRepository;
        this.problemProgressRepository = problemProgressRepository;
        this.mapper = mapper;
        this.eventPublisher = eventPublisher;
    }

    @Transactional
    public ContributorApplicationResponse apply(UUID applicantId) {
        if (applicationRepository.existsByApplicantIdAndStatus(applicantId, ContributorApplicationStatus.PENDING)) {
            throw new ApiException(HttpStatus.CONFLICT, "You already have a pending contributor application");
        }
        ContributorApplication application = ContributorApplication.builder().applicantId(applicantId).build();
        return mapper.toResponse(applicationRepository.save(application));
    }

    @Transactional(readOnly = true)
    public List<ContributorApplicationResponse> listMine(UUID applicantId) {
        return applicationRepository.findByApplicantIdOrderByCreatedAtDesc(applicantId).stream()
                .map(mapper::toResponse)
                .toList();
    }

    /**
     * Only the top {@value #TOP_N} PENDING applications, ranked by
     * {@link ContributorApplicationPriority} — not every pending row.
     * Deliberate: this is expected to eventually run into the hundreds,
     * and there's no filtering UI yet (too early in the project for one to
     * be worth building — see the 2025-09-19 chat). Uncached, recomputed
     * on every read — same "low-traffic, admin-only, freshness-sensitive"
     * reasoning as the contribution queue.
     */
    @Transactional(readOnly = true)
    public List<TopContributorApplicationResponse> listTopPending() {
        return applicationRepository.findByStatus(ContributorApplicationStatus.PENDING).stream()
                .map(this::toRankedResponse)
                .sorted(Comparator.comparingLong(TopContributorApplicationResponse::priorityScore).reversed())
                .limit(TOP_N)
                .toList();
    }

    private TopContributorApplicationResponse toRankedResponse(ContributorApplication application) {
        ProblemProgressLeaderboardStats stats =
                problemProgressRepository.aggregateLeaderboardStats(application.getApplicantId());
        User applicant = userRepository.findById(application.getApplicantId())
                .orElseThrow(() -> new IllegalStateException("Applicant not found: " + application.getApplicantId()));
        long priority = ContributorApplicationPriority.score(
                stats.getSolvedCount(), stats.getTotalPoints(), applicant.getCurrentStreak());
        return new TopContributorApplicationResponse(
                mapper.toResponse(application),
                applicant.getDisplayName(),
                stats.getSolvedCount(),
                stats.getTotalPoints(),
                applicant.getCurrentStreak(),
                priority);
    }

    /**
     * Flips the applicant's role to CONTRIBUTOR in the SAME transaction as
     * the application's own status write — an application marked APPROVED
     * with the role change silently missing (or vice versa) would be a
     * real, hard-to-detect bug, same reasoning
     * {@code AttemptFinalizer.finalizeVerified} already follows for
     * attempt+progress. `lockById` (not the plain `findById`) since this
     * mutates the user row — same convention
     * {@code dailychallenge.DailyChallengeService}'s streak read-modify-
     * write already uses for a `users` row write.
     */
    @Transactional
    public ContributorApplicationResponse approve(UUID id, UUID actorId) {
        ContributorApplication application = getOrThrow(id);
        assertPending(application);

        User applicant = userRepository.lockById(application.getApplicantId())
                .orElseThrow(() -> new IllegalStateException("Applicant not found: " + application.getApplicantId()));
        applicant.setRole(Role.CONTRIBUTOR);
        userRepository.save(applicant);

        application.setStatus(ContributorApplicationStatus.APPROVED);
        application.setReviewedAt(Instant.now());
        application.setReviewedBy(actorId);
        ContributorApplicationResponse response = mapper.toResponse(applicationRepository.save(application));

        // AFTER_COMMIT (see notification.EmailService) — queued here, inside
        // the still-open transaction, but nothing actually sends until this
        // transaction commits for real.
        eventPublisher.publishEvent(new ContributorApplicationApprovedEvent(applicant.getId()));

        return response;
    }

    @Transactional
    public ContributorApplicationResponse reject(UUID id, UUID actorId) {
        ContributorApplication application = getOrThrow(id);
        assertPending(application);
        application.setStatus(ContributorApplicationStatus.REJECTED);
        application.setReviewedAt(Instant.now());
        application.setReviewedBy(actorId);
        return mapper.toResponse(applicationRepository.save(application));
    }

    private void assertPending(ContributorApplication application) {
        if (application.getStatus() != ContributorApplicationStatus.PENDING) {
            throw new ApiException(HttpStatus.CONFLICT, "Only a pending application can be reviewed");
        }
    }

    private ContributorApplication getOrThrow(UUID id) {
        return applicationRepository.findById(id)
                .orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND, "Contributor application not found: " + id));
    }
}
