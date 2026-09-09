package com.engineeringstudio.api.attempt.verify;

import com.engineeringstudio.api.config.VerifyServiceProperties;
import java.net.http.HttpClient;
import java.time.Duration;
import org.springframework.http.MediaType;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientException;

/**
 * The real Phase 4 implementation, replacing Phase 3's StubVerifyClient
 * (deleted — its job was proving the attempt state machine before this
 * existed; that's done, see phase-3's decisions.md #1). A single
 * synchronous HTTP call — no retry (see VerifyServiceProperties), any
 * failure (timeout, connection refused, non-2xx, malformed response)
 * becomes a VerifyException, which AttemptService/AttemptFinalizer turn
 * into the VERIFY_FAILED path.
 */
@Component
public class HttpVerifyClient implements VerifyClient {

    private final RestClient restClient;

    public HttpVerifyClient(VerifyServiceProperties properties) {
        Duration timeout = Duration.ofSeconds(properties.timeoutSeconds());
        var requestFactory = new JdkClientHttpRequestFactory(
                HttpClient.newBuilder().connectTimeout(timeout).build());
        requestFactory.setReadTimeout(timeout);

        this.restClient = RestClient.builder()
                .baseUrl(properties.baseUrl())
                .requestFactory(requestFactory)
                .build();
    }

    @Override
    public VerifyResult verify(VerifyRequest request) {
        try {
            VerifyResult result = restClient.post()
                    .uri("/verify")
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(request)
                    .retrieve()
                    .body(VerifyResult.class);
            if (result == null) {
                throw new VerifyException("verify-service returned an empty response");
            }
            return result;
        } catch (RestClientException e) {
            throw new VerifyException("verify-service call failed: " + e.getMessage(), e);
        }
    }
}
