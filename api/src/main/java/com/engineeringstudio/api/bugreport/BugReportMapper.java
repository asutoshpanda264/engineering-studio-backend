package com.engineeringstudio.api.bugreport;

import com.engineeringstudio.api.bugreport.dto.BugReportResponse;
import org.springframework.stereotype.Component;

@Component
public class BugReportMapper {

    public BugReportResponse toResponse(BugReport b) {
        return new BugReportResponse(
                b.getId(),
                b.getReporterId(),
                b.getDescription(),
                b.getRoute(),
                b.getUserAgent(),
                b.getStatus(),
                b.getAdminNote(),
                b.getResolvedAt(),
                b.getCreatedAt(),
                b.getUpdatedAt());
    }
}
