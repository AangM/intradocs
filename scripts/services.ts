import { loadLocalEnv, command, reportFailure } from './shared.ts';
try {
  loadLocalEnv();
  if (process.argv[2] !== 'stop') throw new Error('Gunakan pnpm services:stop.');
  command('docker', ['compose', '--env-file', '.env.local', '--profile', 'knowledge', 'stop']);
  console.log('Layanan berhenti; volume dan data dipertahankan.');
} catch (e) {
  reportFailure(e);
}
