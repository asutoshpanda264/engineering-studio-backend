package com.engineeringstudio.api.contributorapplication;

import java.util.UUID;

/** Published from {@code ContributorApplicationService.approve} — see {@code notification.EmailService}'s AFTER_COMMIT listener. */
public record ContributorApplicationApprovedEvent(UUID applicantId) {
}
