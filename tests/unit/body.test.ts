import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readBoundedText,
  parseLoginBody,
  BodyLimitError,
} from '../../packages/core/src/http-input.ts';
const request = (body: string, headers: Record<string, string> = {}) =>
  new Request('http://localhost', { method: 'POST', body, headers });
test('body limit counts bytes, not characters', async () => {
  await assert.rejects(readBoundedText(request('你你'), 4), BodyLimitError);
  assert.equal(await readBoundedText(request('okay'), 4), 'okay');
});
test('declared oversized body is rejected before consumption', async () => {
  await assert.rejects(
    readBoundedText(request('small', { 'content-length': '9999' }), 10),
    BodyLimitError,
  );
});
test('empty body is safe and invalid UTF8 is rejected', async () => {
  assert.equal(await readBoundedText(new Request('http://localhost'), 20), '');
  await assert.rejects(
    readBoundedText(
      new Request('http://localhost', { method: 'POST', body: new Uint8Array([0xc3, 0x28]) }),
      20,
    ),
  );
});
test('login strips whitespace from email, not password', () => {
  assert.deepEqual(parseLoginBody('{"email":" u@example.test ","password":" pass "}'), {
    email: 'u@example.test',
    password: ' pass ',
  });
});
for (const body of [
  'null',
  '[]',
  '{',
  '{"email":"a","password":1}',
  '{"email":"a","password":"b","role":"super_admin"}',
  '{"email":"a","password":"b","callbackURL":"https://evil.test"}',
])
  test(`login boundary rejects ${body}`, () => assert.throws(() => parseLoginBody(body)));
