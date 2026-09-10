import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  parseSubmit,
  parseDecision,
  parseFeedback,
  findSensitiveContent,
  requiredApprovalSteps,
  reviewTransition,
  lexicalChunks,
} from '../../packages/core/src/workflow.ts';
const versionId = randomUUID();
test('strict submit: ordered different reviewers, valid dates, no actor spoofing', () => {
  assert.deepEqual(parseSubmit({ versionId, reviewers: ['a', 'b'] }).reviewers, ['a', 'b']);
  for (const reviewers of [[], ['a', 'a'], ['a', 'b', 'c'], ['<script>']])
    assert.throws(() => parseSubmit({ versionId, reviewers }));
  for (const reviewAt of ['2027-02-30', '2027-1-1', 'x'])
    assert.throws(() => parseSubmit({ versionId, reviewers: ['a'], reviewAt }));
  assert.throws(() => parseSubmit({ versionId, reviewers: ['a'], actor: 'spoof' }));
});
test('decision reasons and feedback types are mandatory at boundaries', () => {
  assert.equal(parseDecision({ versionId, decision: 'approve' }).reason, '');
  for (const decision of ['reject', 'changes_requested'])
    assert.throws(() => parseDecision({ versionId, decision, reason: 'short' }));
  assert.throws(() => parseFeedback({ versionId, helpful: 'true' }));
  assert.throws(() => parseFeedback({ versionId, helpful: true, role: 'super_admin' }));
});
test('sensitive classifications and critical labels require two stages', () => {
  for (const classification of ['restricted', 'confidential'])
    assert.equal(requiredApprovalSteps({ classification, labels: [], categorySteps: 1 }), 2);
  assert.equal(
    requiredApprovalSteps({ classification: 'internal', labels: ['Kritikal'], categorySteps: 1 }),
    2,
  );
  assert.equal(
    requiredApprovalSteps({ classification: 'internal', labels: [], categorySteps: 1 }),
    1,
  );
});
const transition = {
  state: 'in_review' as const,
  author: 'author',
  actor: 'r1',
  assignee: 'r1',
  stage: 1,
  stages: 2,
  previousApproved: true,
  decision: 'approve' as const,
  unresolved: 0,
};
test('self, wrong reviewer, wrong order and unresolved findings block approval', () => {
  for (const p of [
    { actor: 'author' },
    { actor: 'r2' },
    { previousApproved: false },
    { unresolved: 1 },
  ])
    assert.throws(() => reviewTransition({ ...transition, ...p }));
});
test('only final approval requests publication', () => {
  assert.equal(reviewTransition(transition).enqueue, false);
  assert.equal(reviewTransition({ ...transition, stage: 2 }).enqueue, true);
  assert.equal(reviewTransition({ ...transition, decision: 'changes_requested' }).enqueue, false);
});
test('preflight findings are deterministic and do not echo sensitive values', () => {
  const a = findSensitiveContent('-----BEGIN PRIVATE KEY-----\npassword = fake-fixture-only');
  assert(a.some((v) => v.severity === 'block'));
  assert(a.some((v) => v.severity === 'review'));
  assert(!JSON.stringify(a).includes('fake-fixture-only'));
});
test('lexical chunks preserve every Unicode code point, number and newline', () => {
  const s = '# Ünikode 🌍\n1. Jalankan 50000 byte; SLA 99.90%.\n'.repeat(100);
  const c = lexicalChunks(s, 64);
  assert.equal(c.map((v) => v.text).join(''), s);
  assert(c.every((v, i) => v.ordinal === i && v.lineEnd >= v.lineStart));
});
test('empty or oversized canonical and invalid chunk sizes are rejected', () => {
  assert.throws(() => lexicalChunks(' '));
  assert.throws(() => lexicalChunks('a'.repeat(2097153)));
  assert.throws(() => lexicalChunks('abc', 63));
});
