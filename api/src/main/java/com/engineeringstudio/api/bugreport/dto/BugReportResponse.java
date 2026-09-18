package com.engineeringstudio.api.bugreport.dto;

import com.engineeringstudio.api.bugreport.BugReportStatus;
import java.time.Instant;
import java.util.UUID;

public record BugReportResponse(
        UUID id,
        UUID reporterId,
        String description,
        String route,
        String userAgent,
        BugReportStatus status,
        String adminNote,
        Instant resolvedAt,
        Instant createdAt,
        Instant updatedAt) {
}
