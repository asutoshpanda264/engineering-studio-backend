package com.engineeringstudio.api.attempt;

import com.engineeringstudio.api.attempt.dto.AttemptResponse;
import com.engineeringstudio.api.common.json.JsonUtil;
import java.util.Map;
import org.springframework.stereotype.Component;
import tools.jackson.core.type.TypeReference;

@Component
public class AttemptMapper {

    private static final TypeReference<Map<String, Object>> MAP = new TypeReference<>() {
    };

    public AttemptResponse toResponse(Attempt a) {
        return new AttemptResponse(
                a.getId(),
                a.getScenario().getId(),
                a.getScenarioVersion(),
                a.getMode(),
                a.getStatus(),
                a.getStartedAt(),
                a.getSubmittedAt(),
                a.getTotalPausedSeconds(),
                a.getElapsedSeconds(),
                JsonUtil.fromJson(a.getVerifyMetrics(), MAP),
                JsonUtil.fromJson(a.getVerifyEvaluation(), MAP),
                JsonUtil.fromJson(a.getVerifyScore(), MAP));
    }
}
