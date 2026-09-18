package com.engineeringstudio.api.contribution.dto;

import com.engineeringstudio.api.contribution.ContributionCategory;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

public record ContributionRequest(
        @NotNull ContributionCategory category,

        @NotBlank @Size(max = 200) String title,

        @NotBlank String body,

        /** Optional — mainly for VLOG, where the content lives at an external URL. */
        @Size(max = 500) String link) {
}
