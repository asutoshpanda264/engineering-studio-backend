package com.engineeringstudio.api.common.error;

import java.util.LinkedHashMap;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

/**
 * Catches exceptions at the edge of the whole app so individual controllers
 * never write try/catch — a controller method either returns a value or
 * throws, and this is the only place that turns a throw into an HTTP
 * response.
 */
@RestControllerAdvice
public class GlobalExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);

    @ExceptionHandler(ApiException.class)
    public ResponseEntity<ApiError> handleApiException(ApiException ex) {
        return ResponseEntity.status(ex.getStatus())
                .body(ApiError.of(ex.getStatus().value(), ex.getStatus().getReasonPhrase(), ex.getMessage()));
    }

    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<ApiError> handleValidation(MethodArgumentNotValidException ex) {
        Map<String, String> fieldErrors = new LinkedHashMap<>();
        ex.getBindingResult().getFieldErrors().forEach(fe ->
                fieldErrors.put(fe.getField(), fe.getDefaultMessage()));
        return ResponseEntity.status(HttpStatus.BAD_REQUEST)
                .body(ApiError.validation(HttpStatus.BAD_REQUEST.value(), fieldErrors));
    }

    /**
     * `@PreAuthorize`'s method-security interceptor throws this when an
     * authenticated-but-wrong-role caller hits a gated endpoint — it's a
     * RuntimeException, so without this specific handler it would fall
     * through to {@link #handleUnexpected}'s catch-all below and return
     * 500 instead of the correct 403 (a real regression this project hit
     * directly — adding the catch-all handler broke
     * `AuthFlowIntegrationTest`'s existing 403-as-USER assertion, since
     * Spring MVC's `@ExceptionHandler` resolution runs BEFORE the
     * exception would ever reach Spring Security's own filter-based
     * translation, and picks whichever handler matches, most-specific
     * first). Spring resolves handlers by most-specific exception type
     * regardless of method order in this class, so this and
     * {@link #handleUnexpected} coexist safely — this one just has to
     * exist at all.
     */
    @ExceptionHandler(AccessDeniedException.class)
    public ResponseEntity<ApiError> handleAccessDenied(AccessDeniedException ex) {
        return ResponseEntity.status(HttpStatus.FORBIDDEN)
                .body(ApiError.of(HttpStatus.FORBIDDEN.value(), HttpStatus.FORBIDDEN.getReasonPhrase(), ex.getMessage()));
    }

    /**
     * Anything genuinely unexpected (a verify-service response this app
     * couldn't process, a bug) — logged with its real stack trace
     * server-side, but never leaked to the client as a stack trace or
     * Spring's default Whitelabel error page. Added in Phase 5 once a
     * second real failure mode existed beyond ApiException (see
     * ProblemProgressService — a malformed score from verify/ throws a
     * plain IllegalStateException, not an ApiException); worth having
     * generally so every error response keeps the same ApiError shape,
     * not just the ones we anticipated.
     */
    @ExceptionHandler(Exception.class)
    public ResponseEntity<ApiError> handleUnexpected(Exception ex) {
        log.error("Unhandled exception", ex);
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                .body(ApiError.of(
                        HttpStatus.INTERNAL_SERVER_ERROR.value(),
                        HttpStatus.INTERNAL_SERVER_ERROR.getReasonPhrase(),
                        "Something went wrong. Please try again."));
    }
}
