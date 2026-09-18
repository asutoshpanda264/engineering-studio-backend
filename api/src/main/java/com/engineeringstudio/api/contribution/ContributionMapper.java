package com.engineeringstudio.api.contribution;

import com.engineeringstudio.api.contribution.dto.ContributionResponse;
import org.springframework.stereotype.Component;

@Component
public class ContributionMapper {

    public ContributionResponse toResponse(Contribution c) {
        return new ContributionResponse(
                c.getId(),
                c.getContributorId(),
                c.getCategory(),
                c.getTitle(),
                c.getBody(),
                c.getLink(),
                c.getStatus(),
                c.getPointsAwarded(),
                c.getReviewedAt(),
                c.getReviewedBy(),
                c.getCreatedAt(),
                c.getUpdatedAt());
    }
}
