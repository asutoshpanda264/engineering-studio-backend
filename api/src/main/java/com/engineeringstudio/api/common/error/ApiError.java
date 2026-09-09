package com.engineeringstudio.api.common.error;

import java.time.Instant;
import java.util.Map;

/**
 * The one JSON shape every error response takes, whatever caused it — a
 * frontend integrating against this API only ever needs to handle one error
 * envelope, not a different shape per endpoint.
 */
public record ApiError(Instant timestamp, int status, String error, String message, Map<String, String> fieldErrors) {
    public static ApiError of(int status, String error, String message) {
        return new ApiError(Instant.now(), status, error, message, Map.of());
    }

    public static ApiError validation(int status, Map<String, String> fieldErrors) {
        return new ApiError(Instant.now(), status, "Validation Failed", "One or more fields are invalid", fieldErrors);
    }
}
