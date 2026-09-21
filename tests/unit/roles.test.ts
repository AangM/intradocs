import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CAPABILITIES,
  effectiveCapabilities,
  hasCapability,
  roleCapabilities,
  roleLabel,
} from '../../packages/core/src/index.ts';
import { parseCustomRole } from '../../packages/core/src/roles.ts';
import { parseAssignment } from '../../packages/core/src/taxonomy.ts';

test('a custom role only narrows: effective capabilities are base minus denied, never more', () => {
  const base = roleCapabilities('knowledge_admin');
  const eff = effectiveCapabilities('knowledge_admin', ['users.view', 'analytics.view']);
  assert.deepEqual(
    eff,
    base.filter((c) => c !== 'users.view' && c !== 'analytics.view'),
  );
  // Denying something the base never had changes nothing and grants nothing.
  assert.deepEqual(effectiveCapabilities('viewer', ['users.manage']), []);
  assert.deepEqual(effectiveCapabilities('contributor', []), roleCapabilities('contributor'));
});

test('hasCapability honours the actor’s effective set when present, the role table otherwise', () => {
  const narrowed = {
    role: 'contributor' as const,
    active: true,
    capabilities: effectiveCapabilities('contributor', ['documents.upload']),
  };
  assert.equal(hasCapability(narrowed, 'documents.upload'), false);
  assert.equal(hasCapability({ role: 'contributor', active: true }, 'documents.upload'), true);
  // A crafted capabilities list can never exceed the role: the server computes it from
  // the base role, and an inactive account has nothing regardless.
  assert.equal(
    hasCapability(
      { role: 'viewer', active: false, capabilities: [...CAPABILITIES] },
      'users.manage',
    ),
    false,
  );
});

test('the shown role name is the custom role’s, else the built-in label', () => {
  assert.equal(roleLabel({ role: 'viewer' }), 'Viewer');
  assert.equal(
    roleLabel({ role: 'viewer', customRole: { id: 'x', name: 'Pembaca SOP' } }),
    'Pembaca SOP',
  );
  assert.equal(roleLabel({ role: 'reviewer', customRole: null }), 'Reviewer');
});

test('parseCustomRole refuses denials outside the base, unknown colours and super_admin bases', () => {
  const ok = parseCustomRole({
    name: '  Penulis SOP ',
    description: 'Unggah tanpa review',
    color: 'sky',
    baseRole: 'reviewer',
    deniedCapabilities: ['documents.review', 'documents.review'],
  });
  assert.equal(ok.name, 'Penulis SOP');
  assert.deepEqual(ok.deniedCapabilities, ['documents.review']);
  assert.throws(
    () =>
      parseCustomRole({
        name: 'X1',
        description: '',
        color: 'sky',
        baseRole: 'contributor',
        deniedCapabilities: ['users.manage'],
      }),
    /role dasar/,
  );
  assert.throws(
    () =>
      parseCustomRole({
        name: 'X1',
        description: '',
        color: 'pink',
        baseRole: 'viewer',
        deniedCapabilities: [],
      }),
    /Warna/,
  );
  assert.throws(
    () =>
      parseCustomRole({
        name: 'X1',
        description: '',
        color: 'sky',
        baseRole: 'super_admin',
        deniedCapabilities: [],
      }),
    /Role dasar/,
  );
  assert.throws(
    () =>
      parseCustomRole({
        name: 'X1',
        description: '',
        color: 'sky',
        baseRole: 'viewer',
        deniedCapabilities: [],
        extra: 1,
      }),
    /Field/,
  );
  // An update carries its revision; a create does not.
  assert.equal(
    parseCustomRole(
      {
        name: 'X1',
        description: '',
        color: 'sky',
        baseRole: 'viewer',
        deniedCapabilities: [],
        revision: 3,
      },
      true,
    ).revision,
    3,
  );
});

test('parseAssignment accepts an optional custom role id and validates it as a uuid', () => {
  const plain = parseAssignment({ role: 'viewer', scopeAll: false, categoryIds: [] });
  assert.equal(plain.customRoleId, null);
  const withRole = parseAssignment({
    role: 'viewer',
    scopeAll: false,
    categoryIds: [],
    customRoleId: '10000000-0000-4000-8000-000000000001',
  });
  assert.equal(withRole.customRoleId, '10000000-0000-4000-8000-000000000001');
  assert.throws(() =>
    parseAssignment({ role: 'viewer', scopeAll: false, categoryIds: [], customRoleId: 'nope' }),
  );
});
