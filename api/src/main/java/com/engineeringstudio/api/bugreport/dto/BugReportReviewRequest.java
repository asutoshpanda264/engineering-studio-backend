package com.engineeringstudio.api.bugreport.dto;

import com.engineeringstudio.api.bugreport.BugReportStatus;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

/** `PATCH /bug-reports/{id}` body — an admin moves the status and/or leaves a note. */
public record BugReportReviewRequest(
        @NotNull BugReportStatus status,

        @Size(max = 2000) String adminNote) {
}
