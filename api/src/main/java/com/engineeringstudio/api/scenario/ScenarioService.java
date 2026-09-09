package com.engineeringstudio.api.scenario;

import com.engineeringstudio.api.auth.Role;
import com.engineeringstudio.api.common.error.ApiException;
import com.engineeringstudio.api.common.json.JsonUtil;
import com.engineeringstudio.api.scenario.dto.ScenarioRequest;
import com.engineeringstudio.api.scenario.dto.ScenarioResponse;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.core.type.TypeReference;

@Service
public class ScenarioService {

    private static final TypeReference<Map<String, Object>> MAP = new TypeReference<>() {
    };

    private final ScenarioRepository scenarioRepository;
    private final ScenarioVersionRepository versionRepository;
    private final ScenarioMapper mapper;

    public ScenarioService(
            ScenarioRepository scenarioRepository,
            ScenarioVersionRepository versionRepository,
            ScenarioMapper mapper) {
        this.scenarioRepository = scenarioRepository;
        this.versionRepository = versionRepository;
        this.mapper = mapper;
    }

    @Transactional
    public ScenarioResponse createDraft(ScenarioRequest request, UUID actorId) {
        if (scenarioRepository.existsById(request.id())) {
            throw new ApiException(HttpStatus.CONFLICT, "A scenario with this id already exists");
        }
        Scenario scenario = new Scenario();
        scenario.setId(request.id());
        scenario.setStatus(ScenarioStatus.DRAFT);
        scenario.setVersion(1);
        scenario.setCreatedBy(actorId);
        mapper.applyRequest(request, scenario);
        return mapper.toResponse(scenarioRepository.save(scenario));
    }

    /**
     * Snapshots the scenario's current state into scenario_versions BEFORE
     * applying the new content — so scenario_versions always holds every
     * version that ever existed except the current one, and the main row
     * always holds the latest. See masterdoc phase-2 decisions.md for why
     * this ordering matters for an Attempt's fairness guarantee.
     */
    @Transactional
    public ScenarioResponse update(String id, ScenarioRequest request, UUID actorId, Role actorRole) {
        if (!id.equals(request.id())) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "Scenario id in the request body must match the path");
        }
        Scenario scenario = getOrThrow(id);
        assertCanEdit(scenario, actorId, actorRole);

        ScenarioVersion snapshot = ScenarioVersion.builder()
                .scenarioId(scenario.getId())
                .version(scenario.getVersion())
                .snapshot(mapper.toSnapshotJson(scenario))
                .build();
        versionRepository.save(snapshot);

        mapper.applyRequest(request, scenario);
        scenario.setVersion(scenario.getVersion() + 1);
        return mapper.toResponse(scenarioRepository.save(scenario));
    }

    private void assertCanEdit(Scenario scenario, UUID actorId, Role actorRole) {
        if (actorRole == Role.ADMIN) {
            return;
        }
        if (!actorId.equals(scenario.getCreatedBy())) {
            throw new ApiException(HttpStatus.FORBIDDEN, "You can only edit your own scenarios");
        }
        if (scenario.getStatus() != ScenarioStatus.DRAFT) {
            throw new ApiException(HttpStatus.FORBIDDEN, "Only an admin can edit a published scenario");
        }
    }

    @Transactional
    public ScenarioResponse publish(String id) {
        Scenario scenario = getOrThrow(id);
        if (scenario.getStatus() != ScenarioStatus.DRAFT) {
            throw new ApiException(HttpStatus.CONFLICT, "Only a draft scenario can be published");
        }
        scenario.setStatus(ScenarioStatus.PUBLISHED);
        return mapper.toResponse(scenarioRepository.save(scenario));
    }

    @Transactional
    public ScenarioResponse archive(String id) {
        Scenario scenario = getOrThrow(id);
        if (scenario.getStatus() != ScenarioStatus.PUBLISHED) {
            throw new ApiException(HttpStatus.CONFLICT, "Only a published scenario can be archived");
        }
        scenario.setStatus(ScenarioStatus.ARCHIVED);
        return mapper.toResponse(scenarioRepository.save(scenario));
    }

    @Transactional
    public void delete(String id) {
        Scenario scenario = getOrThrow(id);
        if (scenario.getStatus() != ScenarioStatus.DRAFT) {
            throw new ApiException(HttpStatus.CONFLICT,
                    "Only a draft scenario can be deleted — archive a published one instead");
        }
        scenarioRepository.delete(scenario);
    }

    @Transactional(readOnly = true)
    public List<ScenarioResponse> listPublished() {
        return scenarioRepository.findByStatus(ScenarioStatus.PUBLISHED).stream()
                .map(mapper::toResponse)
                .toList();
    }

    /** Published-only — a draft/archived id 404s here even if it exists, so the public endpoint never leaks unpublished content. */
    @Transactional(readOnly = true)
    public ScenarioResponse getPublished(String id) {
        Scenario scenario = getOrThrow(id);
        if (scenario.getStatus() != ScenarioStatus.PUBLISHED) {
            throw new ApiException(HttpStatus.NOT_FOUND, "Scenario not found: " + id);
        }
        return mapper.toResponse(scenario);
    }

    /**
     * Historical versions live in scenario_versions — except the CURRENT
     * one, which is never snapshotted there (it's the live row). Falls
     * back to the live row when the requested version is the current one,
     * so callers don't need to know that distinction.
     */
    @Transactional(readOnly = true)
    public Map<String, Object> getVersion(String id, int version) {
        Scenario scenario = getOrThrow(id);
        if (version == scenario.getVersion()) {
            return JsonUtil.fromJson(mapper.toSnapshotJson(scenario), MAP);
        }
        ScenarioVersion snapshot = versionRepository.findByScenarioIdAndVersion(id, version)
                .orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND,
                        "No version " + version + " for scenario " + id));
        return JsonUtil.fromJson(snapshot.getSnapshot(), MAP);
    }

    @Transactional(readOnly = true)
    public List<ScenarioResponse> listDrafts(UUID actorId, Role actorRole) {
        List<Scenario> drafts = actorRole == Role.ADMIN
                ? scenarioRepository.findByStatus(ScenarioStatus.DRAFT)
                : scenarioRepository.findByStatusAndCreatedBy(ScenarioStatus.DRAFT, actorId);
        return drafts.stream().map(mapper::toResponse).toList();
    }

    private Scenario getOrThrow(String id) {
        return scenarioRepository.findById(id)
                .orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND, "Scenario not found: " + id));
    }
}
