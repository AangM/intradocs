import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { ROOT, PNPM, loadLocalEnv, reportFailure } from './shared.ts';
import { childEnvironment } from './runtime-env.ts';
function main() {
  loadLocalEnv();
  const production = process.argv.includes('--production');
  const children: ChildProcess[] = [];
  let closing = false;
  function signalTree(child: ChildProcess, signal: NodeJS.Signals) {
    if (!child.pid) return;
    try {
      if (process.platform === 'win32')
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      else process.kill(-child.pid, signal);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ESRCH')
        console.error('Layanan lokal perlu dihentikan manual.');
    }
  }
  function stop(code = 0) {
    if (closing) return;
    closing = true;
    for (const child of children) signalTree(child, 'SIGTERM');
    const timeout = setTimeout(() => {
      for (const child of children) signalTree(child, 'SIGKILL');
      process.exit(code);
    }, 5000);
    timeout.unref();
    process.exitCode = code;
  }
  const commands = [
    ['--filter', '@intradocs/web', production ? 'start' : 'dev'],
    ['--filter', '@intradocs/worker', 'dev'],
  ];
  for (const [index, args] of commands.entries()) {
    const child = spawn(PNPM, args, {
      cwd: ROOT,
      env: childEnvironment(process.env, index === 0 ? 'web' : 'worker'),
      stdio: 'inherit',
      shell: process.platform === 'win32',
      detached: process.platform !== 'win32',
    });
    children.push(child);
    child.on('error', () => stop(1));
    child.on('exit', (code) => {
      if (!closing) stop(code || 1);
    });
  }
  process.on('SIGINT', () => stop());
  process.on('SIGTERM', () => stop());
  console.log(
    `IntraDocs lokal: ${process.env.APP_URL} · Data sintetis · AI off. Ctrl+C untuk berhenti.`,
  );
}
try {
  main();
} catch (e) {
  reportFailure(e);
}
