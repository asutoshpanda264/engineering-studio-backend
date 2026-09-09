package com.engineeringstudio.api.attempt;

import com.engineeringstudio.api.attempt.dto.AttemptResponse;
import com.engineeringstudio.api.attempt.dto.StartAttemptRequest;
import com.engineeringstudio.api.attempt.dto.SubmitAttemptRequest;
import com.engineeringstudio.api.attempt.verify.VerifyClient;
import com.engineeringstudio.api.attempt.verify.VerifyException;
import com.engineeringstudio.api.attempt.verify.VerifyRequest;
import com.engineeringstudio.api.attempt.verify.VerifyResult;
import com.engineeringstudio.api.auth.Role;
import com.engineeringstudio.api.auth.User;
import com.engineeringstudio.api.auth.UserRepository;
import com.engineeringstudio.api.common.error.ApiException;
import com.engineeringstudio.api.common.json.JsonUtil;
import com.engineeringstudio.api.scenario.Scenario;
import com.engineeringstudio.api.scenario.ScenarioRepository;
import com.engineeringstudio.api.scenario.ScenarioService;
import com.engineeringstudio.api.scenario.ScenarioStatus;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class AttemptService {

    private final AttemptRepository attemptRepository;
    private final AttemptPauseIntervalRepository pauseIntervalRepository;
    private final ScenarioRepository scenarioRepository;
    private final ScenarioService scenarioService;
    private final UserRepository userRepository;
    private final AttemptMapper mapper;
    private final AttemptFinalizer finalizer;
    private final VerifyClient verifyClient;
    private final Clock clock;

    public AttemptService(
            AttemptRepository attemptRepository,
            AttemptPauseIntervalRepository pauseIntervalRepository,
            ScenarioRepository scenarioRepository,
            ScenarioService scenarioService,
            UserRepository userRepository,
            AttemptMapper mapper,
            AttemptFinalizer finalizer,
            VerifyClient verifyClient,
            Clock clock) {
        this.attemptRepository = attemptRepository;
        this.pauseIntervalRepository = pauseIntervalRepository;
        this.scenarioRepository = scenarioRepository;
        this.scenarioService = scenarioService;
        this.userRepository = userRepository;
        this.mapper = mapper;
        this.finalizer = finalizer;
        this.verifyClient = verifyClient;
        this.clock = clock;
    }

    @Transactional
    public AttemptResponse start(StartAttemptRequest request, UUID actorId) {
        Scenario scenario = scenarioRepository.findById(request.scenarioId())
                .orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND, "Scenario not found: " + request.scenarioId()));
        if (scenario.getStatus() != ScenarioStatus.PUBLISHED) {
            throw new ApiException(HttpStatus.CONFLICT, "Only a published scenario can be attempted");
        }
        // Looking the User row up rather than a reference-by-id: JPA needs
        // a managed/attachable entity for the @ManyToOne column, and this
        // also fails loudly (not a foreign-key constraint violation deep
        // in Hibernate) if the JWT ever named a userId that's since been
        // deleted.
        User user = userRepository.findById(actorId)
                .orElseThrow(() -> new IllegalStateException("Authenticated user not found: " + actorId));

        Attempt attempt = Attempt.builder()
                .user(user)
                .scenario(scenario)
                .scenarioVersion(scenario.getVersion())
                .mode(request.mode())
                .status(AttemptStatus.IN_PROGRESS)
                .startedAt(clock.instant())
                .totalPausedSeconds(0)
                .build();
        return mapper.toResponse(attemptRepository.save(attempt));
    }

    @Transactional
    public AttemptResponse pause(UUID attemptId, UUID actorId) {
        Attempt attempt = getOwnedOrThrow(attemptId, actorId);
        if (attempt.getMode() != AttemptMode.TIMED) {
            throw new ApiException(HttpStatus.CONFLICT, "Pause is only available in timed mode");
        }
        if (attempt.getStatus() != AttemptStatus.IN_PROGRESS) {
            throw new ApiException(HttpStatus.CONFLICT, "Only an in-progress attempt can be paused");
        }

        Instant now = clock.instant();
        attempt.setStatus(AttemptStatus.PAUSED);
        attempt.setPausedAt(now);
        attemptRepository.save(attempt);

        pauseIntervalRepository.save(AttemptPauseInterval.builder()
                .attemptId(attempt.getId())
                .pausedAt(now)
                .build());

        return mapper.toResponse(attempt);
    }

    @Transactional
    public AttemptResponse resume(UUID attemptId, UUID actorId) {
        Attempt attempt = getOwnedOrThrow(attemptId, actorId);
        if (attempt.getStatus() != AttemptStatus.PAUSED) {
            throw new ApiException(HttpStatus.CONFLICT, "Only a paused attempt can be resumed");
        }

        Instant now = clock.instant();
        int pausedSeconds = (int) Duration.between(attempt.getPausedAt(), now).getSeconds();
        attempt.setTotalPausedSeconds(attempt.getTotalPausedSeconds() + pausedSeconds);
        attempt.setStatus(AttemptStatus.IN_PROGRESS);
        attempt.setPausedAt(null);
        attemptRepository.save(attempt);

        pauseIntervalRepository.findByAttemptIdAndResumedAtIsNull(attempt.getId())
                .ifPresent(interval -> {
                    interval.setResumedAt(now);
                    pauseIntervalRepository.save(interval);
                });

        return mapper.toResponse(attempt);
    }

    /**
     * Deliberately NOT @Transactional — see AttemptFinalizer's Javadoc for
     * why. The elapsed-time/paused-time math below is computed in memory
     * only (never written) before the verify call; only one of
     * `finalizeVerified`/`markVerifyFailed` ever actually persists
     * anything, in its own independent transaction.
     */
    public AttemptResponse submit(UUID attemptId, SubmitAttemptRequest request, UUID actorId) {
        Attempt attempt = getOwnedOrThrow(attemptId, actorId);
        if (attempt.getStatus() == AttemptStatus.SUBMITTED) {
            throw new ApiException(HttpStatus.CONFLICT, "This attempt was already submitted");
        }
        if (attempt.getStatus() == AttemptStatus.EXPIRED) {
            throw new ApiException(HttpStatus.CONFLICT, "This attempt has expired");
        }

        Instant now = clock.instant();
        // Keyed off `pausedAt != null` (an open pause exists right now),
        // not `status == PAUSED` — so a retry after a prior VERIFY_FAILED
        // (whose status is no longer PAUSED, but whose pausedAt was never
        // touched by the failure path) still closes out correctly.
        int totalPaused = attempt.getTotalPausedSeconds();
        if (attempt.getPausedAt() != null) {
            totalPaused += (int) Duration.between(attempt.getPausedAt(), now).getSeconds();
        }

        Integer elapsedSeconds = null;
        if (attempt.getMode() == AttemptMode.TIMED) {
            long raw = Duration.between(attempt.getStartedAt(), now).getSeconds() - totalPaused;
            elapsedSeconds = (int) Math.max(raw, 0);
        }

        // The exact scenario body this attempt was actually solved against
        // — not necessarily the scenario's current live content, if it's
        // been edited since (getVersion falls back to the live row only
        // when the requested version is still current — see
        // scenario/decisions.md #5). This is what makes the anti-cheat
        // design's fairness guarantee real: verification always happens
        // against the rules that applied when the student started, never
        // rules an admin changed underneath them mid-attempt.
        Scenario scenario = attempt.getScenario();
        Map<String, Object> scenarioBody = scenarioService.getVersion(scenario.getId(), attempt.getScenarioVersion());
        VerifyRequest verifyRequest = new VerifyRequest(scenarioBody, request.graph());

        try {
            VerifyResult result = verifyClient.verify(verifyRequest);
            Attempt saved = finalizer.finalizeVerified(
                    attemptId, elapsedSeconds, totalPaused, JsonUtil.toJson(request.graph()), result);
            return mapper.toResponse(saved);
        } catch (VerifyException e) {
            finalizer.markVerifyFailed(attemptId);
            throw new ApiException(HttpStatus.BAD_GATEWAY, "Could not verify submission — please try submitting again");
        }
    }

    @Transactional(readOnly = true)
    public AttemptResponse get(UUID attemptId, UUID actorId, Role actorRole) {
        Attempt attempt = attemptRepository.findById(attemptId)
                .orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND, "Attempt not found: " + attemptId));
        if (actorRole != Role.ADMIN && !attempt.getUser().getId().equals(actorId)) {
            throw new ApiException(HttpStatus.FORBIDDEN, "This is not your attempt");
        }
        return mapper.toResponse(attempt);
    }

    @Transactional(readOnly = true)
    public List<AttemptResponse> listMine(UUID actorId) {
        return attemptRepository.findByUserIdOrderByCreatedAtDesc(actorId).stream()
                .map(mapper::toResponse)
                .toList();
    }

    private Attempt getOwnedOrThrow(UUID attemptId, UUID actorId) {
        Attempt attempt = attemptRepository.findById(attemptId)
                .orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND, "Attempt not found: " + attemptId));
        if (!attempt.getUser().getId().equals(actorId)) {
            throw new ApiException(HttpStatus.FORBIDDEN, "This is not your attempt");
        }
        return attempt;
    }
}
