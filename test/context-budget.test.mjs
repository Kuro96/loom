import test from 'node:test';
import assert from 'node:assert/strict';
import { redact, safeUrl } from '../src/context/budget.mjs';

test('debug sanitizes credential fields, known header secrets and free-text tokens', () => {
  const secret = 'a-real-header-secret-123456';
  const value = redact({api_key:secret, text:`Bearer ${secret}; token=synthetic; sk-123456789abcdefghijk`, nested:{password:'hidden'},max_tokens:42}, [secret]);
  const json = JSON.stringify(value);
  for (const token of [secret,'synthetic','sk-123456789abcdefghijk','hidden']) assert.ok(!json.includes(token));
  assert.equal(value.max_tokens,42);
  assert.equal(safeUrl('https://name:password@example.test/v1/chat/completions?token=secret'), 'https://example.test/v1/chat/completions');
});
