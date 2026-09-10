import { spawn, spawnSync } from 'node:child_process';
export type CommandResult = {
  ok: boolean;
  code: number | null;
  reason: 'exit' | 'timeout' | 'output_limit' | 'start_error';
  output: string;
};
// Finite commands only. Output is bounded in memory and redacted BEFORE it can be logged.
export function redactLog(text: string, secrets: readonly string[] = []): string {
  let safe = text;
  for (const secret of [...secrets]
    .filter((s) => s.length >= 4)
    .sort((a, b) => b.length - a.length))
    safe = safe.split(secret).join('[REDACTED]');
  return safe
    .replace(/(postgres(?:ql)?:\/\/)[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(
      /(\"?(?:password|token|secret|cookie|authorization)\"?\s*[:=]\s*)(?:\"[^\"]*\"|'[^']*'|[^\s,}]+)/gi,
      '$1[REDACTED]',
    );
}
export async function runCommand(
  binary: string,
  args: readonly string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs: number;
    maxOutputBytes?: number;
    secrets?: readonly string[];
  },
): Promise<CommandResult> {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1)
    throw new Error('Batas waktu command tidak valid.');
  const max = options.maxOutputBytes ?? 1024 * 1024;
  if (!Number.isSafeInteger(max) || max < 1) throw new Error('Batas output tidak valid.');
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let length = 0,
      finished = false,
      reason: CommandResult['reason'] = 'exit';
    const child = spawn(binary, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      shell: process.platform === 'win32' && binary.endsWith('.cmd'),
    });
    function stop(why: CommandResult['reason']) {
      if (reason !== 'exit') return;
      reason = why;
      if (!child.pid) return;
      try {
        if (process.platform === 'win32')
          spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
            stdio: 'ignore',
            timeout: 5000,
          });
        else process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }
    const timer = setTimeout(() => stop('timeout'), options.timeoutMs);
    function finish(code: number | null) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({
        ok: reason === 'exit' && code === 0,
        code,
        reason,
        output: redactLog(Buffer.concat(chunks).toString('utf8'), options.secrets),
      });
    }
    function collect(bytes: Buffer) {
      const room = Math.max(0, max - length);
      if (room) chunks.push(bytes.subarray(0, room));
      length += bytes.length;
      if (length > max) stop('output_limit');
    }
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('error', () => {
      reason = 'start_error';
      finish(null);
    });
    child.once('close', finish);
  });
}
