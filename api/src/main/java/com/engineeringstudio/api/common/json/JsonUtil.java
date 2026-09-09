package com.engineeringstudio.api.common.json;

import tools.jackson.core.JacksonException;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.json.JsonMapper;

/**
 * A plain, manually-instantiated mapper — deliberately NOT a Spring bean,
 * kept private to internal entity/DTO mapping code rather than anywhere
 * near an HTTP request or response.
 *
 * Uses Jackson 3.x (`tools.jackson`), the SAME line Spring Boot 4
 * auto-configures for its own HTTP serialization (see
 * masterdoc/phase-1-auth-rbac/explain_boot4-migration.md) — this project's
 * classpath actually carries two unrelated Jackson major versions
 * (classic `com.fasterxml.jackson` 2.x arrives transitively, at *runtime*
 * scope only, via jjwt-jackson; it's never a compile-scope dependency of
 * this module's own code). Deliberately using the one that's a real
 * compile-scope dependency here, rather than adding a redundant Jackson
 * 2.x dependency just to keep old-looking code — see
 * masterdoc/phase-2-scenario-crud/decisions.md for the full reasoning and
 * the surprise that led here (Jackson 2.x compiled fine in this same
 * package's first draft locally, then failed at `mvn compile` specifically
 * because of that runtime-vs-compile scope distinction).
 *
 * `JacksonException` is unchecked in Jackson 3.x (unlike 2.x's checked
 * `JsonProcessingException`) — still caught here for a clearer error
 * message on failure, not because Java requires it.
 */
public final class JsonUtil {

    private static final JsonMapper MAPPER = JsonMapper.shared();

    private JsonUtil() {
    }

    public static String toJson(Object value) {
        if (value == null) {
            return null;
        }
        try {
            return MAPPER.writeValueAsString(value);
        } catch (JacksonException e) {
            throw new IllegalStateException("Failed to serialize value to JSON", e);
        }
    }

    public static <T> T fromJson(String json, TypeReference<T> type) {
        if (json == null) {
            return null;
        }
        try {
            return MAPPER.readValue(json, type);
        } catch (JacksonException e) {
            throw new IllegalStateException("Failed to parse stored JSON: " + json, e);
        }
    }
}
