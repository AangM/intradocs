import test from 'node:test';
import assert from 'node:assert/strict';
import { readAiConfig, describeAiConfig } from '../../packages/core/src/ai-config.ts';
import {
  ROLES,
  CAPABILITIES,
  hasCapability,
  initials,
  FEATURES,
  isRole,
  formatDate,
} from '../../packages/core/src/index.ts';
import {
  parseUuid,
  parseCatalogQuery,
  parseStatusBody,
  safeReturnTo,
  safeLink,
  assertSameOrigin,
  headingSlug,
  InputError,
} from '../../packages/core/src/validation.ts';
import {
  readRuntimeConfig,
  readWorkerConfig,
  assertLocalDatabase,
} from '../../packages/core/src/config.ts';
import { childEnvironment } from '../../scripts/runtime-env.ts';
const baseline = {
  APP_PROFILE: 'local-dev',
  APP_URL: 'http://localhost:3000',
  AUTH_MODE: 'local',
  AI_PROVIDER: 'off',
  STORAGE_DRIVER: 'filesystem',
  STORAGE_ROOT: 'var/storage',
  INTRADOCS_ROOT: '/tmp/intradocs',
  DATABASE_URL:
    'postgresql://intradocs_app:abcdefghijklmnopqrstuvwxyz0123456789@127.0.0.1:54329/intradocs',
  AUTH_DATABASE_URL:
    'postgresql://intradocs_auth:abcdefghijklmnopqrstuvwxyz0123456789@127.0.0.1:54329/intradocs',
  BETTER_AUTH_SECRET: 'abcdefghijklmnopqrstuvwxyz0123456789',
};
test('five explicit built-in roles; no implicit sensitive-data capability', () => {
  assert.equal(ROLES.length, 5);
  assert(!CAPABILITIES.some((c) => c.includes('sensitive')));
  assert(isRole('viewer'));
  assert(!isRole('root'));
});
for (const role of ROLES) {
  test(`inactive ${role} has no capabilities`, () => {
    for (const cap of CAPABILITIES)
      assert.equal(hasCapability({ role, active: false }, cap), false);
  });
  test(`only super admin may manage users: ${role}`, () => {
    assert.equal(hasCapability({ role, active: true }, 'users.manage'), role === 'super_admin');
  });
}
test('viewer cannot upload, review, or open admin surfaces', () => {
  for (const c of CAPABILITIES)
    assert.equal(hasCapability({ role: 'viewer', active: true }, c), false);
});
test('contributor can reach upload but not review/users', () => {
  assert(hasCapability({ role: 'contributor', active: true }, 'documents.upload'));
  assert(!hasCapability({ role: 'contributor', active: true }, 'documents.review'));
  assert(!hasCapability({ role: 'contributor', active: true }, 'users.view'));
});
test('M1–M3 capabilities are enabled; AI and production remain disabled', () => {
  assert.equal(FEATURES.uploads, true);
  assert(
    Object.entries(FEATURES)
      .filter(([k]) => !['uploads', 'approvalMutations'].includes(k))
      .every(([, v]) => v === false),
  );
  assert(Object.isFrozen(FEATURES));
});
test('names and dates display predictably without assumed gender', () => {
  assert.equal(initials('  Rizky Ananda '), 'RA');
  assert.equal(initials('单名'), '单');
  assert.equal(initials(''), '');
  assert.equal(formatDate('invalid'), '—');
});
test('UUID is normalized and checked', () => {
  assert.equal(
    parseUuid('AABBCCDD-0000-4000-8000-000000000001'),
    'aabbccdd-0000-4000-8000-000000000001',
  );
  for (const s of ['../foo', '1', '00000000-0000-0000-0000-000000000001', null])
    assert.throws(() => parseUuid(s), InputError);
});
test('catalog defaults are explicit published-only', () => {
  assert.deepEqual(parseCatalogQuery({}), {
    q: '',
    category: null,
    page: 1,
    status: 'published',
    sort: 'updated',
  });
});
test('search remains literal data, not SQL or wildcard instructions', () => {
  assert.equal(parseCatalogQuery({ q: "x%' OR 1=1 --" }).q, "x%' OR 1=1 --");
});
for (const input of [
  { q: ['a', 'b'] },
  { q: 'a'.repeat(201) },
  { q: 'bad\u0000' },
  { page: '-1' },
  { page: '1.5' },
  { page: '10001' },
  { status: 'secret' },
  { sort: 'random' },
  { category: 'x' },
])
  test(`invalid search boundary ${JSON.stringify(input).slice(0, 60)}`, () =>
    assert.throws(() => parseCatalogQuery(input), InputError));
for (const input of [
  'https://evil.example',
  '//evil.example',
  '/\\evil.example',
  '/\r\nLocation:x',
  '/%5c%5cevil.example',
  '/%2f%2fevil.example',
  '/%0d%0aheader',
  '/api/auth/sign-out',
  '/login?returnTo=foo',
  '/bad%zz',
])
  test(`unsafe redirect rejected: ${JSON.stringify(input)}`, () =>
    assert.equal(safeReturnTo(input), '/help-center'));
test('safe internal navigation preserves query, not fragment', () => {
  assert.equal(safeReturnTo('/katalog?q=VPN#x'), '/katalog?q=VPN');
});
for (const value of [
  'javascript:alert(1)',
  'data:text/html,x',
  '//evil.example',
  'file:///etc/passwd',
  'vbscript:evil',
  ' https://example.test',
  'https://user:password@example.test',
  '/\\evil',
])
  test(`unsafe Markdown link rejected: ${value}`, () => assert.equal(safeLink(value), undefined));
test('safe link protocols are deliberately small', () => {
  assert.equal(safeLink('/katalog'), '/katalog');
  assert.equal(safeLink('#user-content-judul'), '#user-content-judul');
  assert.equal(safeLink('https://example.test'), 'https://example.test/');
});
test('same-origin mutations require a real matching Origin', () => {
  assert.doesNotThrow(() => assertSameOrigin('http://localhost:3000', 'http://localhost:3000'));
  for (const o of ['http://127.0.0.1:3000', 'http://[::1]:3000'])
    assert.doesNotThrow(() => assertSameOrigin(o, 'http://localhost:3000'));
  for (const o of [null, 'null', 'http://evil.example', 'http://localhost:3001'])
    assert.throws(() => assertSameOrigin(o, 'http://localhost:3000'), InputError);
});
test('status updates reject role/actor/unknown field injection', () => {
  assert.deepEqual(parseStatusBody({ active: false }), { active: false });
  for (const x of [
    { active: true, role: 'super_admin' },
    { active: 'false' },
    { active: true, actorId: 'spoof' },
    [],
    null,
    {},
  ])
    assert.throws(() => parseStatusBody(x), InputError);
});
test('heading slug supports Indonesian/Unicode headings', () => {
  assert.equal(headingSlug('2.1 Reset Password'), '21-reset-password');
  assert.equal(headingSlug('** Integrasi API **'), 'integrasi-api');
  assert.equal(headingSlug('数据'), '数据');
});
test('valid local profile loads; no silent default to unsafe production', () => {
  assert.equal(readRuntimeConfig(baseline).profile, 'local-dev');
  assert.throws(() => readRuntimeConfig({}));
});
for (const patch of [
  { APP_PROFILE: 'telkom-prod' },
  { APP_PROFILE: 'production' },
  { AI_PROVIDER: 'gemini' },
  { AUTH_MODE: 'oidc' },
  { STORAGE_DRIVER: 's3' },
  { BETTER_AUTH_SECRET: 'short' },
  { APP_URL: 'https://example.com' },
  { APP_URL: 'http://localhost:3000/subpath' },
  { DATABASE_URL: 'postgres://postgres:x@localhost/intradocs' },
  { DATABASE_URL: 'postgres://intradocs_app:x@db.example.com/intradocs' },
  { STORAGE_ROOT: 'apps/web/public/files' },
  { STORAGE_ROOT: 'var/../public' },
  { STORAGE_ROOT: '/tmp/private' },
  { INTRADOCS_ROOT: '' },
])
  test(`config fails closed: ${Object.keys(patch)[0]}=${Object.values(patch)[0]}`, () =>
    assert.throws(() => readRuntimeConfig({ ...baseline, ...patch })));
test('database host guard rejects network hosts and schemes', () => {
  for (const u of ['https://localhost', 'postgres://evil.example/a', 'not-a-url'])
    assert.throws(() => assertLocalDatabase(u));
});
test('worker needs only its own database identity', () => {
  assert.equal(
    readWorkerConfig({
      APP_PROFILE: 'local-dev',
      AI_PROVIDER: 'off',
      WORKER_DATABASE_URL: 'postgres://intradocs_worker:x@localhost/intradocs',
    }).databaseUrl,
    'postgres://intradocs_worker:x@localhost/intradocs',
  );
  assert.throws(() =>
    readWorkerConfig({
      APP_PROFILE: 'local-dev',
      AI_PROVIDER: 'off',
      WORKER_DATABASE_URL: baseline.DATABASE_URL,
    }),
  );
});
test('app and worker never inherit migration/auth secrets they do not need', () => {
  const env = {
    ...baseline,
    PATH: '/bin',
    DATABASE_ADMIN_URL: 'admin-secret',
    POSTGRES_PASSWORD: 'root-secret',
    WORKER_DATABASE_URL: 'worker-secret',
    UNRELATED_SECRET: 'unrelated-secret',
  };
  const web = childEnvironment(env, 'web'),
    worker = childEnvironment(env, 'worker');
  for (const e of [web, worker]) {
    assert.equal(e.DATABASE_ADMIN_URL, undefined);
    assert.equal(e.POSTGRES_PASSWORD, undefined);
    assert.equal(e.UNRELATED_SECRET, undefined);
    assert.equal(e.NEXT_TELEMETRY_DISABLED, '1');
  }
  assert.equal(web.WORKER_DATABASE_URL, undefined);
  assert.equal(web.PORT, '3000');
  assert.equal(worker.DATABASE_URL, undefined);
  assert.equal(worker.AUTH_DATABASE_URL, undefined);
  assert.equal(worker.BETTER_AUTH_SECRET, undefined);
  assert.equal(worker.WORKER_DATABASE_URL, 'worker-secret');
});

test('external generation is refused until it is acknowledged in words', () => {
  const base = {
    APP_PROFILE: 'local-dev',
    AI_PROVIDER: 'weknora-local',
    AI_GENERATION: 'weknora-local',
    WEKNORA_BASE_URL: 'http://127.0.0.1:47080',
    WEKNORA_API_KEY: 'sk-local-abcdefghijklmnop',
    WEKNORA_KNOWLEDGE_BASE_ID: 'kb-uji-1234',
  };
  // Default stays on this machine.
  assert.equal(readAiConfig(base).generationLocation, 'local');
  // Asking for external without the acknowledgement is refused, and the message says why.
  assert.throws(
    () => readAiConfig({ ...base, AI_GENERATION_LOCATION: 'external' }),
    /AI_EXTERNAL_ACKNOWLEDGED/,
  );
  // With the acknowledgement it is allowed, and the status reports it rather than hiding it.
  const external = readAiConfig({
    ...base,
    AI_GENERATION_LOCATION: 'external',
    AI_EXTERNAL_ACKNOWLEDGED: 'synthetic-corpus-only',
  });
  assert.equal(external.generationLocation, 'external');
  assert.equal(describeAiConfig(external).generationLocation, 'external');
  // A typo is a hard error, never a silent fallback to local.
  assert.throws(
    () => readAiConfig({ ...base, AI_GENERATION_LOCATION: 'cloud' }),
    /local atau external/,
  );
});

test('the status shape still never carries the WeKnora key', () => {
  const status = describeAiConfig(
    readAiConfig({
      APP_PROFILE: 'local-dev',
      AI_PROVIDER: 'weknora-local',
      AI_GENERATION: 'off',
      WEKNORA_BASE_URL: 'http://127.0.0.1:47080',
      WEKNORA_API_KEY: 'sk-local-abcdefghijklmnop',
      WEKNORA_KNOWLEDGE_BASE_ID: 'kb-uji-1234',
    }),
  );
  assert(!JSON.stringify(status).includes('sk-local-abcdefghijklmnop'));
  assert.equal(status.apiKeyConfigured, true);
});
