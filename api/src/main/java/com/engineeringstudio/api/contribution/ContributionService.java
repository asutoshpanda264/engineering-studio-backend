package com.engineeringstudio.api.contribution;

import com.engineeringstudio.api.common.error.ApiException;
import com.engineeringstudio.api.contribution.dto.ContributionRequest;
import com.engineeringstudio.api.contribution.dto.ContributionResponse;
import com.engineeringstudio.api.contribution.dto.PendingContributionResponse;
import java.time.Instant;
import java.util.Comparator;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class ContributionService {

    private final ContributionRepository contributionRepository;
    private final ContributionMapper mapper;

    public ContributionService(ContributionRepository contributionRepository, ContributionMapper mapper) {
        this.contributionRepository = contributionRepository;
        this.mapper = mapper;
    }

    @Transactional
    public ContributionResponse submit(ContributionRequest request, UUID actorId) {
        Contribution contribution = Contribution.builder()
                .contributorId(actorId)
                .category(request.category())
                .title(request.title())
                .body(request.body())
                .link(request.link())
                .build();
        return mapper.toResponse(contributionRepository.save(contribution));
    }

    @Transactional(readOnly = true)
    public List<ContributionResponse> listMine(UUID actorId) {
        return contributionRepository.findByContributorIdOrderByCreatedAtDesc(actorId).stream()
                .map(mapper::toResponse)
                .toList();
    }

    /**
     * The pending queue, ordered by each submitting contributor's total
     * approved-contribution points, descending, per the product's "high
     * rating contributor at the top" requirement. Fetches every PENDING
     * row, then one per-contributor aggregate query each (same shape as
     * {@code ContributionRepository.totalApprovedPoints}'s own Javadoc —
     * mirrors how `leaderboard.LeaderboardService` recomputes one user at
     * a time rather than a single query grouped across everyone) and
     * sorts in Java. Uncached, recomputed on every read — low-traffic,
     * admin-only, freshness-sensitive, same reasoning as
     * {@code ScenarioService.listDrafts}.
     */
    @Transactional(readOnly = true)
    public List<PendingContributionResponse> listPending() {
        return contributionRepository.findByStatus(ContributionStatus.PENDING).stream()
                .map(c -> new PendingContributionResponse(
                        mapper.toResponse(c), contributionRepository.totalApprovedPoints(c.getContributorId())))
                .sorted(Comparator.comparingLong(PendingContributionResponse::contributorApprovedPoints).reversed())
                .toList();
    }

    /** Points are awarded synchronously, in the same transaction as the status flip — never a separate/deferred step, same rule {@code ProblemProgressService.recordOutcome} follows. */
    @Transactional
    public ContributionResponse approve(UUID id, UUID actorId) {
        Contribution contribution = getOrThrow(id);
        assertPending(contribution);
        contribution.setStatus(ContributionStatus.APPROVED);
        contribution.setPointsAwarded(ContributionPointsCalculator.pointsFor(contribution.getCategory()));
        contribution.setReviewedAt(Instant.now());
        contribution.setReviewedBy(actorId);
        return mapper.toResponse(contributionRepository.save(contribution));
    }

    @Transactional
    public ContributionResponse reject(UUID id, UUID actorId) {
        Contribution contribution = getOrThrow(id);
        assertPending(contribution);
        contribution.setStatus(ContributionStatus.REJECTED);
        contribution.setReviewedAt(Instant.now());
        contribution.setReviewedBy(actorId);
        return mapper.toResponse(contributionRepository.save(contribution));
    }

    private void assertPending(Contribution contribution) {
        if (contribution.getStatus() != ContributionStatus.PENDING) {
            throw new ApiException(HttpStatus.CONFLICT, "Only a pending contribution can be reviewed");
        }
    }

    private Contribution getOrThrow(UUID id) {
        return contributionRepository.findById(id)
                .orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND, "Contribution not found: " + id));
    }
}
