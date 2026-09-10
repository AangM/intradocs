import 'server-only';
import { ClamAVScanner, clamAVOptions } from '@intradocs/core/clamav';
export function getScanner() {
  return new ClamAVScanner(clamAVOptions(process.env));
}
export async function scannerStatus(): Promise<{ ready: boolean; message: string }> {
  try {
    const scanner = new ClamAVScanner({ ...clamAVOptions(process.env), timeoutMs: 2000 });
    const v = await scanner.readiness();
    return { ready: true, message: `ClamAV ${v.version} siap; signature ${v.signatureVersion}.` };
  } catch {
    return {
      ready: false,
      message:
        'Pemindai belum siap atau signature belum mutakhir. Jalankan pnpm knowledge:start, lalu pnpm scanner:check.',
    };
  }
}
