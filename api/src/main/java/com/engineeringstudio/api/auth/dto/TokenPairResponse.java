package com.engineeringstudio.api.auth.dto;

public record TokenPairResponse(String accessToken, String refreshToken) {
}
