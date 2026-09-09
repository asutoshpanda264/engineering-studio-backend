package com.engineeringstudio.api.attempt.verify;

import java.util.Map;

/**
 * The canonical, server-side-computed outcome of a submission — whatever
 * implements VerifyClient produced this by actually running the
 * simulation (or, for now, by pretending to — see StubVerifyClient), never
 * by trusting anything the client claimed. Shapes deliberately left as
 * plain Maps (not fully-typed Java classes) for the same reason
 * ScenarioResponse's nested fields are — see scenario/explain_scenario.md.
 */
public record VerifyResult(Map<String, Object> metrics, Map<String, Object> evaluation, Map<String, Object> score) {
}
