package com.engineeringstudio.api.contributorapplication;

import com.engineeringstudio.api.contributorapplication.dto.ContributorApplicationResponse;
import org.springframework.stereotype.Component;

@Component
public class ContributorApplicationMapper {

    public ContributorApplicationResponse toResponse(ContributorApplication a) {
        return new ContributorApplicationResponse(
                a.getId(), a.getApplicantId(), a.getStatus(), a.getReviewedAt(), a.getReviewedBy(), a.getCreatedAt(),
                a.getUpdatedAt());
    }
}
