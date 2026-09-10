import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, PNPM, loadLocalEnv } from './shared.ts';
import { runCommand, redactLog } from './command-runner.ts';
type Gate = {
  name: string;
  status: 'not_run' | 'pass' | 'fail' | 'blocked';
  detail?: string;
  log?: string;
};
const flags = process.argv.slice(2),
  preflightOnly = flags.includes('--preflight');
const names = [
  'environment',
  'source',
  'format',
  'lint',
  'typecheck',
  'unit',
  'content',
  'python',
  'converter',
  'build',
  'running_app',
  'scanner',
  'storage_dry_run',
  'database',
  'http',
];
const report = {
  release: '0.3.0',
  at: new Date().toISOString(),
  status: 'running',
  gates: names.map((name) => ({ name, status: 'not_run' }) as Gate),
  notCovered: [
    'visual/browser review',
    'performance/load',
    'power-loss/restore',
    'production policy',
  ],
};
const secrets: string[] = [];
async function main() {
  if (flags.some((f) => f !== '--preflight') || flags.length > 1)
    throw new Error(
      'Gunakan pnpm verify:local, atau tambahkan --preflight untuk pemeriksaan prasyarat saja.',
    );
  const output = path.join(ROOT, 'artifacts');
  await mkdir(output, { recursive: true, mode: 0o700 });
  if ((await lstat(output)).isSymbolicLink())
    throw new Error('Folder laporan tidak boleh symlink.');
  const gate = (name: string) => report.gates.find((g) => g.name === name)!;
  const save = () =>
    writeFile(
      path.join(output, 'local-verification.json'),
      JSON.stringify(report, null, 2) + '\n',
      { mode: 0o600 },
    );
  try {
    const environment = gate('environment');
    const required = [
      ['node_modules/typescript/package.json', '5.9.3'],
      ['node_modules/tsx/package.json', '4.23.13'],
      ['node_modules/pg/package.json', '8.23.0'],
      ['apps/web/node_modules/next/package.json', '16.3.4'],
    ];
    const missing = required.some(([file, version]) => {
      try {
        return JSON.parse(readFileSync(path.join(ROOT, file!), 'utf8')).version !== version;
      } catch {
        return true;
      }
    });
    if (
      process.versions.node.split('.')[0] !== '24' ||
      missing ||
      !existsSync(path.join(ROOT, '.env.local'))
    ) {
      environment.status = 'blocked';
      environment.detail =
        'Butuh Node 24, dependency sesuai lockfile (pnpm install --frozen-lockfile), dan setup lokal yang sudah ada. Tidak ada install/reset otomatis.';
      report.status = 'blocked';
      console.log(environment.detail);
      process.exitCode = 1;
      return;
    }
    loadLocalEnv();
    environment.status = 'pass';
    for (const name of [
      'BETTER_AUTH_SECRET',
      'KNOWLEDGE_TOKEN',
      'POSTGRES_PASSWORD',
      'DATABASE_URL',
      'AUTH_DATABASE_URL',
      'WORKER_DATABASE_URL',
      'DATABASE_ADMIN_URL',
    ]) {
      const value = process.env[name];
      if (value) {
        secrets.push(value);
        try {
          const password = decodeURIComponent(new URL(value).password);
          if (password) secrets.push(password);
        } catch {
          /* not a URL */
        }
      }
    }
    if (preflightOnly) {
      report.status = 'preflight_pass';
      console.log('Prasyarat tersedia; build/integrasi belum dijalankan.');
      return;
    }
    const commands: [string, string][] = [
      ['source', 'verify:source'],
      ['format', 'format:check'],
      ['lint', 'lint'],
      ['typecheck', 'typecheck'],
      ['unit', 'test:unit'],
      ['content', 'test:content'],
      ['python', 'test:python'],
      ['build', 'build'],
      ['scanner', 'scanner:check'],
      ['converter', 'knowledge:check'],
      ['storage_dry_run', 'storage:gc'],
      ['database', 'test:integration'],
      ['http', 'test:http'],
    ];
    for (const [name, command] of commands) {
      if (name === 'scanner') {
        const running = gate('running_app');
        try {
          const response = await fetch(process.env.APP_URL + '/api/health', {
            signal: AbortSignal.timeout(5000),
          });
          const info = await response.json();
          if (
            !response.ok ||
            info.status !== 'ok' ||
            info.profile !== 'local-dev' ||
            info.ai !== 'off' ||
            info.release !== report.release
          )
            throw new Error();
          running.status = 'pass';
        } catch {
          running.status = 'blocked';
          running.detail =
            'Jalankan/restart pnpm dev dari folder terbaru di terminal lain, lalu ulangi verifikasi.';
          report.status = 'blocked';
          console.log(running.detail);
          process.exitCode = 1;
          return;
        }
      }
      console.log(`Memeriksa ${name}…`);
      const result = await runCommand(PNPM, [command], {
        cwd: ROOT,
        timeoutMs: 15 * 60 * 1000,
        secrets,
      });
      const item = gate(name);
      item.status = result.ok ? 'pass' : 'fail';
      item.detail = result.reason;
      item.log = `verify-${name}.txt`;
      await writeFile(path.join(output, item.log), result.output, { mode: 0o600 });
      await save();
      if (!result.ok) {
        report.status = 'failed';
        process.exitCode = 1;
        console.log(
          `Gate ${name} gagal. Lihat artifacts/${item.log}; gate selanjutnya tidak diberi PASS.`,
        );
        return;
      }
    }
    report.status = 'passed';
    console.log('Semua gate otomatis lokal lulus. Review visual/produksi tetap terpisah.');
  } catch (error) {
    report.status = 'failed';
    throw error;
  } finally {
    await save();
    console.log('Ringkasan: artifacts/local-verification.json (tinjau sebelum dibagikan).');
  }
}
main().catch((error) => {
  console.error(redactLog(error instanceof Error ? error.message : 'Verifikasi gagal.', secrets));
  process.exitCode = 1;
});
