package com.engineeringstudio.api.bugreport.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

public record BugReportRequest(
        @NotBlank String description,

        /** The route the reporter was on — auto-captured by the frontend, not typed in. */
        @NotBlank @Size(max = 500) String route,

        /** `navigator.userAgent` — auto-captured by the frontend, not typed in. */
        @NotBlank @Size(max = 500) String userAgent) {
}
