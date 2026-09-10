import { randomBytes } from 'node:crypto';
import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, loadLocalEnv, command, reportFailure } from './shared.ts';
import { ClamAVScanner, clamAVOptions } from '../packages/core/src/clamav.ts';
import { converterOptions } from '../packages/core/src/converter.ts';
async function main() {
  loadLocalEnv();
  const action = process.argv[2];
  if (action === 'start') {
    const filename = path.join(ROOT, '.env.local');
    const existing = await readFile(filename, 'utf8');
    if (!/^KNOWLEDGE_TOKEN=/m.test(existing)) {
      const token = randomBytes(32).toString('base64url');
      await appendFile(filename, `\nKNOWLEDGE_TOKEN=${token}\n`, { mode: 0o600 });
      process.env.KNOWLEDGE_TOKEN = token;
    }
    converterOptions(process.env); // Do not silently overwrite a malformed operator setting.
    command('docker', [
      'compose',
      '--env-file',
      '.env.local',
      '--profile',
      'knowledge',
      'up',
      '-d',
      '--build',
      'clamav',
      'converter',
    ]);
    console.log(
      'Scanner dan converter dinyalakan. Signature pertama memerlukan internet; dokumen tidak dikirim keluar.',
    );
    console.log('Jalankan pnpm scanner:check dan pnpm knowledge:check, lalu restart pnpm dev.');
  } else if (action === 'stop') {
    command('docker', [
      'compose',
      '--env-file',
      '.env.local',
      '--profile',
      'knowledge',
      'stop',
      'clamav',
      'converter',
    ]);
    console.log('Scanner/converter berhenti; data dan reader tetap tersedia.');
  } else if (action === 'check') {
    const scanner = new ClamAVScanner(clamAVOptions(process.env));
    const evidence = await scanner.scan(
      Buffer.from('IntraDocs synthetic scanner readiness check.\n'),
    );
    console.log(
      `Scan teks sintetis lulus: ClamAV ${evidence.version}, signature ${evidence.signatureVersion}, tanggal ${evidence.signatureDate}.`,
    );
  } else if (action === 'converter-check') {
    const c = converterOptions(process.env);
    const r = await fetch(c.url.replace('/convert', '/health'), {
      headers: { Authorization: `Bearer ${c.token}` },
      signal: AbortSignal.timeout(5000),
    });
    const body = await r.json();
    if (!r.ok || body.pipeline !== 'canonical-v2') throw new Error('Converter belum siap.');
    console.log(
      'Converter canonical-v2 siap: PDF bertesks, DOCX, XLSX; AI off; isolasi egress bergantung profil Compose.',
    );
  } else
    throw new Error(
      'Gunakan knowledge:start, knowledge:stop, scanner:check, atau knowledge:check.',
    );
}
main().catch(reportFailure);
