import test from 'node:test';
import assert from 'node:assert/strict';
import { providerDiagnosticText, runtimeFailureText } from '../dist/tui/errors.js';

const actionableCodes = [
  'provider_credential_missing',
  'provider_credential_unbound',
  'credential_store_unavailable',
  'host_model_config_missing',
  'provider_api_form_required',
  'provider_base_url_required',
  'provider_model_required',
  'model_service_not_found',
  'model_not_available',
  'provider_transport_failed',
  'provider_timeout',
  'provider_http_error',
  'provider_stream_invalid',
  'provider_tool_args_invalid',
  'provider_output_exhausted',
  'provider_empty_response',
  'provider_stream_incomplete',
  'provider_stream_interrupted',
  'provider_finish_reason_invalid',
  'provider_tool_call_invalid',
  'exec_temp_cleanup_failed',
  'exec_script_snapshot_cleanup_failed',
  'exec_sandbox_cleanup_failed',
  'exec_sandbox_setup_failed',
  'exec_termination_cleanup_failed',
  'provider_output_budget_invalid',
  'provider_output_budget_unsupported',
];

test('known runtime failures give next steps in Chinese and English', () => {
  for (const code of actionableCodes) {
    const chinese = runtimeFailureText(code);
    const english = runtimeFailureText(code, 'en');
    assert.ok(chinese, `${code} has Chinese guidance`);
    assert.ok(english, `${code} has English guidance`);
    assert.match(chinese, /[。；：]|\/model|\/credentials/u, `${code} gives a next step`);
    assert.doesNotMatch(english, /[\u3400-\u9fff]/u, `${code} English text contains no Chinese`);
  }
});

test('credential and response failures avoid exposing secret or response details', () => {
  const credential = runtimeFailureText('provider_credential_missing')!;
  const response = runtimeFailureText('provider_http_error')!;
  assert.match(credential, /\/credentials/u);
  assert.match(credential, /环境变量/u);
  assert.match(credential, /桌面/u);
  assert.doesNotMatch(response, /response body|原始响应|响应正文/u);
});

test('unknown runtime failure codes remain available to the caller', () => {
  assert.equal(runtimeFailureText('future_error_code'), undefined);
  assert.equal(runtimeFailureText('future_error_code', 'en'), undefined);
});

test('provider diagnostics show safe, actionable metadata in both locales', () => {
  const diagnostic = {
    category: 'rate_limit', status: 429, attempts: 3,
    responseReceived: true, streamReceived: false, recoverable: true,
    url: 'https://user:secret@example.invalid/?key=private',
  };
  const chinese = providerDiagnosticText(diagnostic)!;
  const english = providerDiagnosticText(diagnostic, 'en')!;
  assert.match(chinese, /HTTP 429.*请求限流.*尝试 3 次.*收到响应.*未收到响应流.*可恢复/u);
  assert.match(english, /HTTP 429.*rate limit.*3 attempts.*response received.*no stream data.*recoverable/u);
  assert.doesNotMatch(chinese + english, /secret|private|example\.invalid/u);
  assert.equal(providerDiagnosticText({ category: 'http', attempts: 0 }), undefined);
});
