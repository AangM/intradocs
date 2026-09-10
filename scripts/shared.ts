import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { readRuntimeConfig, assertLocalDatabase } from '../packages/core/src/config.ts';
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PNPM = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
export function loadLocalEnv(): void {
  const file = path.join(ROOT, '.env.local');
  if (!existsSync(file)) throw new Error('Belum ada .env.local. Jalankan pnpm setup:local.');
  process.loadEnvFile(file);
  process.env.INTRADOCS_ROOT = ROOT;
  readRuntimeConfig(process.env);
}
export function localAdminUrl(): string {
  loadLocalEnv();
  const raw = process.env.DATABASE_ADMIN_URL ?? '';
  const u = assertLocalDatabase(raw);
  if (u.host !== new URL(process.env.DATABASE_URL!).host)
    throw new Error('Database migrasi dan aplikasi harus berasal dari instance lokal yang sama.');
  if (u.pathname !== '/intradocs')
    throw new Error('Migrasi/seed hanya untuk database lokal bernama intradocs.');
  return raw;
}
export function command(binary: string, args: string[], options: { quiet?: boolean } = {}): void {
  const r = spawnSync(binary, args, {
    cwd: ROOT,
    env: process.env,
    stdio: options.quiet ? 'pipe' : 'inherit',
    shell: process.platform === 'win32' && binary.endsWith('.cmd'),
  });
  if (r.error || r.status !== 0)
    throw new Error(
      `Perintah gagal: ${binary} ${args.join(' ')}. Pastikan dependency/layanan tersedia.`,
    );
}
export function isMain(url: string): boolean {
  return !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(url);
}
export function reportFailure(error: unknown): never {
  console.error(error instanceof Error ? error.message : 'Operasi gagal.');
  process.exit(1);
}
