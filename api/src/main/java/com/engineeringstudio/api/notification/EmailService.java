package com.engineeringstudio.api.notification;

import com.engineeringstudio.api.auth.User;
import com.engineeringstudio.api.auth.UserRepository;
import com.engineeringstudio.api.contributorapplication.ContributorApplicationApprovedEvent;
import java.util.Properties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.mail.SimpleMailMessage;
import org.springframework.mail.javamail.JavaMailSenderImpl;
import org.springframework.stereotype.Service;
import org.springframework.transaction.event.TransactionPhase;
import org.springframework.transaction.event.TransactionalEventListener;

/**
 * Our own {@code app.mail.*} namespace, deliberately not Spring Boot's
 * built-in {@code spring.mail.*} — that one auto-configures a
 * {@code JavaMailSender} bean the instant {@code spring.mail.host}
 * resolves to ANY value, including the empty string a
 * {@code ${MAIL_HOST:}} placeholder produces when the env var is unset,
 * which would hand this class a bean that then fails at send-time instead
 * of cleanly not existing. Constructing a plain {@code JavaMailSenderImpl}
 * ourselves, only when {@link #host} is actually non-blank, sidesteps that
 * ambiguity entirely (2026-09-19 chat).
 *
 * <p>Until real SMTP credentials are set (host stays blank by default —
 * see application.yml), every send just logs what it would have sent and
 * returns — an approval must never fail, or even appear to, just because
 * email isn't configured yet.
 */
@Service
public class EmailService {

    private static final Logger log = LoggerFactory.getLogger(EmailService.class);

    private final String host;
    private final int port;
    private final String username;
    private final String password;
    private final String from;
    private final UserRepository userRepository;

    public EmailService(
            @Value("${app.mail.host:}") String host,
            @Value("${app.mail.port:587}") int port,
            @Value("${app.mail.username:}") String username,
            @Value("${app.mail.password:}") String password,
            @Value("${app.mail.from:no-reply@engineeringstudio.dev}") String from,
            UserRepository userRepository) {
        this.host = host;
        this.port = port;
        this.username = username;
        this.password = password;
        this.from = from;
        this.userRepository = userRepository;
    }

    /**
     * AFTER_COMMIT — same reasoning {@code leaderboard.LeaderboardService}'s
     * own listener follows: this only fires once
     * {@code ContributorApplicationService.approve}'s transaction (the role
     * flip + application status write) has actually committed, never for
     * an approval that later rolled back.
     */
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    public void onContributorApplicationApproved(ContributorApplicationApprovedEvent event) {
        userRepository.findById(event.applicantId()).ifPresent(this::sendContributorApprovedEmail);
    }

    private void sendContributorApprovedEmail(User user) {
        String subject = "You're approved as an Engineering Studio contributor";
        String body = """
                Hi %s,

                Congrats — your application to become an Engineering Studio contributor has been approved.

                Sign out and sign back in to pick up your new access, then head to /contribute to start submitting.

                — Engineering Studio"""
                .formatted(user.getDisplayName());
        send(user.getEmail(), subject, body);
    }

    private void send(String to, String subject, String body) {
        if (host.isBlank()) {
            log.info("Email not configured (app.mail.host is blank) — would have sent to {}: [{}]", to, subject);
            return;
        }
        try {
            JavaMailSenderImpl mailSender = new JavaMailSenderImpl();
            mailSender.setHost(host);
            mailSender.setPort(port);
            if (!username.isBlank()) {
                mailSender.setUsername(username);
                mailSender.setPassword(password);
                Properties props = mailSender.getJavaMailProperties();
                props.put("mail.smtp.auth", "true");
                props.put("mail.smtp.starttls.enable", "true");
            }

            SimpleMailMessage message = new SimpleMailMessage();
            message.setFrom(from);
            message.setTo(to);
            message.setSubject(subject);
            message.setText(body);
            mailSender.send(message);
        } catch (Exception e) {
            log.error("Failed to send email to {}", to, e);
        }
    }
}
