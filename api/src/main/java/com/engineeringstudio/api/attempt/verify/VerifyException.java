package com.engineeringstudio.api.attempt.verify;

/** Thrown by a VerifyClient when a submission couldn't be verified — network failure, timeout, malformed response. */
public class VerifyException extends RuntimeException {
    public VerifyException(String message) {
        super(message);
    }

    public VerifyException(String message, Throwable cause) {
        super(message, cause);
    }
}
