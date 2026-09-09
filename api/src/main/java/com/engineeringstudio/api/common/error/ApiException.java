package com.engineeringstudio.api.common.error;

import org.springframework.http.HttpStatus;

/**
 * One exception type for every deliberate "reject this request" case in
 * service-layer code, carrying its own HTTP status — rather than either (a)
 * a different exception subclass per case (a lot of boilerplate classes for
 * not much extra type-safety here) or (b) throwing a generic
 * IllegalArgumentException/RuntimeException and having the handler guess
 * the right status from the exception type. Service code just does
 * `throw new ApiException(HttpStatus.CONFLICT, "email already registered")`
 * and GlobalExceptionHandler turns that straight into the response.
 */
public class ApiException extends RuntimeException {

    private final HttpStatus status;

    public ApiException(HttpStatus status, String message) {
        super(message);
        this.status = status;
    }

    public HttpStatus getStatus() {
        return status;
    }
}
