import test from 'node:test';
import assert from 'node:assert/strict';
import { runCommand, redactLog } from '../../scripts/command-runner.ts';
const options = { cwd: process.cwd(), timeoutMs: 5000 };
test('quality runner returns true exit status and captured output', async () => {
  const r = await runCommand(process.execPath, ['-e', 'console.log("synthetic-ok")'], options);
  assert(r.ok);
  assert.equal(r.code, 0);
  assert.match(r.output, /synthetic-ok/);
});
test('failed command is never reported as pass', async () => {
  const r = await runCommand(process.execPath, ['-e', 'process.exit(7)'], options);
  assert.equal(r.ok, false);
  assert.equal(r.code, 7);
});
test('timeout kills a bounded command instead of hanging verification', async () => {
  const r = await runCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    ...options,
    timeoutMs: 100,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'timeout');
});
test('excessive command output is bounded and fails explicitly', async () => {
  const r = await runCommand(process.execPath, ['-e', 'process.stdout.write("x".repeat(100000))'], {
    ...options,
    maxOutputBytes: 1000,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'output_limit');
  assert(r.output.length <= 1000);
});
test('missing executable is a start error, not a skipped success', async () => {
  const r = await runCommand('intradocs-nonexistent-executable', [], options);
  assert.equal(r.reason, 'start_error');
  assert.equal(r.ok, false);
});
test('sensitive URL and tokens are redacted before writing logs', () => {
  const out = redactLog(
    'postgresql://demo:fake-password@localhost/db\n{"token":"synthetic-cookie-value"}\nMY-SYNTHETIC-SECRET',
    ['MY-SYNTHETIC-SECRET'],
  );
  assert(!out.includes('fake-password'));
  assert(!out.includes('synthetic-cookie-value'));
  assert(!out.includes('MY-SYNTHETIC-SECRET'));
  assert(out.includes('[REDACTED]'));
});
