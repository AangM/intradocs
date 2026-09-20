import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ConfigurationError,
  assertDeployedDatabase,
  readRuntimeConfig,
  readWorkerConfig,
} from '../../packages/core/src/config.ts';

/** A minimal, valid deployment environment; each test bends one field out of shape. */
const deployed = {
  APP_PROFILE: 'production',
  AUTH_MODE: 'local',
  AI_PROVIDER: 'weknora-local',
  STORAGE_DRIVER: 'filesystem',
  APP_URL: 'https://intradocs.example.test',
  DATABASE_URL: 'postgres://intradocs_app:pw@db.example.test/intradocs?sslmode=verify-full',
  AUTH_DATABASE_URL: 'postgres://intradocs_auth:pw@db.example.test/intradocs?sslmode=verify-full',
  BETTER_AUTH_SECRET: 'Qx7Fv2Lm9Kd4Rt6Yh1Bn8Jw3Zs5Pc0Ae7Gu2Iv4Ol6Md9Xr1T',
  INTRADOCS_ROOT: '/srv/intradocs',
  STORAGE_ROOT: '/var/lib/intradocs/storage',
};

test('a production profile loads only when every deployment rule is met', () => {
  const c = readRuntimeConfig(deployed);
  assert.equal(c.profile, 'production');
  assert.equal(c.hardened, true);
  assert.equal(c.appUrl, 'https://intradocs.example.test');
  assert.equal(readRuntimeConfig({ ...deployed, APP_PROFILE: 'staging' }).hardened, true);
  // No profile at all is refused: there is no implicit default either way.
  assert.throws(
    () => readRuntimeConfig({ ...deployed, APP_PROFILE: undefined }),
    ConfigurationError,
  );
  assert.throws(() => readRuntimeConfig({ ...deployed, APP_PROFILE: 'prod' }), ConfigurationError);
});

for (const [label, patch] of [
  ['plain http', { APP_URL: 'http://intradocs.example.test' }],
  ['localhost origin', { APP_URL: 'https://localhost' }],
  ['origin with a path', { APP_URL: 'https://intradocs.example.test/app' }],
  [
    'database without TLS',
    { DATABASE_URL: 'postgres://intradocs_app:pw@db.example.test/intradocs' },
  ],
  [
    'auth database without TLS',
    { AUTH_DATABASE_URL: 'postgres://intradocs_auth:pw@db.example.test/intradocs' },
  ],
  [
    'owner role instead of the app role',
    { DATABASE_URL: 'postgres://postgres:pw@db.example.test/intradocs?sslmode=verify-full' },
  ],
  [
    'auth and app on different databases',
    {
      AUTH_DATABASE_URL:
        'postgres://intradocs_auth:pw@other.example.test/intradocs?sslmode=verify-full',
    },
  ],
  [
    'a 32-character secret that local-dev would accept',
    { BETTER_AUTH_SECRET: 'Qx7Fv2Lm9Kd4Rt6Yh1Bn8Jw3Zs5Pc0Ae' },
  ],
  [
    'a guessable secret',
    { BETTER_AUTH_SECRET: 'change-me-change-me-change-me-change-me-change-me' },
  ],
  [
    'a low-variety secret',
    { BETTER_AUTH_SECRET: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
  ],
  ['storage under a webroot', { STORAGE_ROOT: '/srv/intradocs/public/files' }],
  ['relative storage', { STORAGE_ROOT: 'var/storage' }],
  ['storage escaping its volume', { STORAGE_ROOT: '/var/lib/../../etc' }],
  ['SSO claimed but unimplemented', { AUTH_MODE: 'oidc' }],
  ['a cloud model provider', { AI_PROVIDER: 'gemini' }],
  ['an S3 driver', { STORAGE_DRIVER: 's3' }],
] as const)
  test(`production fails closed: ${label}`, () =>
    assert.throws(() => readRuntimeConfig({ ...deployed, ...patch }), ConfigurationError));

test('an unencrypted link to another host needs an explicit private-network acknowledgement', () => {
  const plain = 'postgres://intradocs_app:pw@postgres:5432/intradocs';
  const auth = 'postgres://intradocs_auth:pw@postgres:5432/intradocs';
  // Two containers on one compose network: no sslmode, refused by default...
  assert.throws(
    () => readRuntimeConfig({ ...deployed, DATABASE_URL: plain, AUTH_DATABASE_URL: auth }),
    /DATABASE_PRIVATE_NETWORK/,
  );
  // ...accepted only once the operator has written the acknowledgement down.
  assert.equal(
    readRuntimeConfig({
      ...deployed,
      DATABASE_URL: plain,
      AUTH_DATABASE_URL: auth,
      DATABASE_PRIVATE_NETWORK: 'true',
    }).hardened,
    true,
  );
  // "yes", "1" or anything but the exact word does not count.
  assert.throws(() =>
    readRuntimeConfig({
      ...deployed,
      DATABASE_URL: plain,
      AUTH_DATABASE_URL: auth,
      DATABASE_PRIVATE_NETWORK: '1',
    }),
  );
  assert.doesNotThrow(() => assertDeployedDatabase(plain, true));
  assert.throws(() => assertDeployedDatabase(plain, false));
});

test('a database on the same machine as the app may skip TLS; anything remote may not', () => {
  assert.doesNotThrow(() =>
    assertDeployedDatabase('postgres://intradocs_app:pw@127.0.0.1/intradocs'),
  );
  assert.doesNotThrow(() =>
    assertDeployedDatabase('postgres://intradocs_app:pw@localhost/intradocs?sslmode=disable'),
  );
  assert.throws(() => assertDeployedDatabase('postgres://intradocs_app:pw@db.example.test/x'));
  assert.throws(() =>
    assertDeployedDatabase('postgres://intradocs_app:pw@db.example.test/x?sslmode=disable'),
  );
  assert.throws(() => assertDeployedDatabase('mysql://intradocs_app:pw@db.example.test/x'));
  assert.throws(() => assertDeployedDatabase('not-a-url'));
});

test('the worker keeps its own identity on a deployment too', () => {
  assert.equal(
    readWorkerConfig({
      APP_PROFILE: 'production',
      AI_PROVIDER: 'weknora-local',
      WORKER_DATABASE_URL:
        'postgres://intradocs_worker:pw@db.example.test/intradocs?sslmode=verify-full',
    }).databaseUrl,
    'postgres://intradocs_worker:pw@db.example.test/intradocs?sslmode=verify-full',
  );
  // The app's own role is not the worker's, and a remote worker connection needs TLS.
  assert.throws(() =>
    readWorkerConfig({
      APP_PROFILE: 'production',
      AI_PROVIDER: 'off',
      WORKER_DATABASE_URL: 'postgres://intradocs_app:pw@db.example.test/x?sslmode=verify-full',
    }),
  );
  assert.throws(() =>
    readWorkerConfig({
      APP_PROFILE: 'production',
      AI_PROVIDER: 'off',
      WORKER_DATABASE_URL: 'postgres://intradocs_worker:pw@db.example.test/x',
    }),
  );
});
