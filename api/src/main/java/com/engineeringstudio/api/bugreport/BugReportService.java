package com.engineeringstudio.api.bugreport;

import com.engineeringstudio.api.bugreport.dto.BugReportRequest;
import com.engineeringstudio.api.bugreport.dto.BugReportResponse;
import com.engineeringstudio.api.bugreport.dto.BugReportReviewRequest;
import com.engineeringstudio.api.common.error.ApiException;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class BugReportService {

    private final BugReportRepository bugReportRepository;
    private final BugReportMapper mapper;

    public BugReportService(BugReportRepository bugReportRepository, BugReportMapper mapper) {
        this.bugReportRepository = bugReportRepository;
        this.mapper = mapper;
    }

    @Transactional
    public BugReportResponse file(BugReportRequest request, UUID actorId) {
        BugReport report = BugReport.builder()
                .reporterId(actorId)
                .description(request.description())
                .route(request.route())
                .userAgent(request.userAgent())
                .build();
        return mapper.toResponse(bugReportRepository.save(report));
    }

    @Transactional(readOnly = true)
    public List<BugReportResponse> listAll() {
        return bugReportRepository.findAllByOrderByCreatedAtDesc().stream().map(mapper::toResponse).toList();
    }

    /** Sets `resolvedAt` the moment a report first reaches RESOLVED — moving it back out doesn't clear that timestamp, same "keep the historical fact" reasoning `Contribution.reviewedAt` follows. */
    @Transactional
    public BugReportResponse review(UUID id, BugReportReviewRequest request) {
        BugReport report = getOrThrow(id);
        report.setStatus(request.status());
        report.setAdminNote(request.adminNote());
        if (request.status() == BugReportStatus.RESOLVED && report.getResolvedAt() == null) {
            report.setResolvedAt(Instant.now());
        }
        return mapper.toResponse(bugReportRepository.save(report));
    }

    private BugReport getOrThrow(UUID id) {
        return bugReportRepository.findById(id)
                .orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND, "Bug report not found: " + id));
    }
}
