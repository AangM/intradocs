// Where the converter is reached: every known profile, loopback only, and only with a token.
import test from 'node:test';
import assert from 'node:assert/strict';
import { converterOptions } from '../../packages/core/src/converter.ts';

const token = 'a'.repeat(40);

test('staging and production convert too, on loopback, with the token', () => {
  for (const APP_PROFILE of ['local-dev', 'staging', 'production']) {
    const c = converterOptions({ APP_PROFILE, KNOWLEDGE_PORT: '8092', KNOWLEDGE_TOKEN: token });
    assert.equal(c.url, 'http://127.0.0.1:8092/convert');
    assert.equal(c.token, token);
  }
});

test('an unknown profile, a missing or weak token, or a bad port is refused', () => {
  assert.throws(() => converterOptions({ APP_PROFILE: 'telkom-prod', KNOWLEDGE_TOKEN: token }));
  assert.throws(() => converterOptions({ KNOWLEDGE_TOKEN: token }));
  assert.throws(() => converterOptions({ APP_PROFILE: 'staging' }));
  assert.throws(() => converterOptions({ APP_PROFILE: 'staging', KNOWLEDGE_TOKEN: 'short' }));
  assert.throws(() =>
    converterOptions({ APP_PROFILE: 'staging', KNOWLEDGE_TOKEN: token, KNOWLEDGE_PORT: '80' }),
  );
});
