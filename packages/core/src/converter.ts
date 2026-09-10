import { timingSafeEqual } from 'node:crypto';
import { readBoundedBytes } from './http-input.ts';
import {
  convertText,
  digest,
  UploadError,
  type UploadFile,
  type ConvertedText,
} from './uploads.ts';
export interface DocumentConverter {
  convert(file: UploadFile, signal?: AbortSignal): Promise<ConvertedText>;
}
export const LOCAL_CONVERTER = { maxResponseBytes: 5 * 1024 * 1024, timeoutMs: 35000 } as const;
export function converterOptions(env: Record<string, string | undefined>) {
  const raw = env.KNOWLEDGE_PORT ?? '8091';
  if (!/^\d{1,5}$/.test(raw) || Number(raw) < 1024 || Number(raw) > 65535)
    throw new UploadError('converter_config', 'Port converter tidak valid.', 503);
  const token = env.KNOWLEDGE_TOKEN ?? '';
  if (env.APP_PROFILE !== 'local-dev' || !/^[A-Za-z0-9_-]{32,128}$/.test(token))
    throw new UploadError(
      'converter_unavailable',
      'Converter belum disiapkan. Jalankan pnpm knowledge:start.',
      503,
    );
  return { url: `http://127.0.0.1:${raw}/convert`, token };
}
export class LocalDocumentConverter implements DocumentConverter {
  constructor(private readonly env: Record<string, string | undefined>) {}
  async convert(file: UploadFile, signal?: AbortSignal): Promise<ConvertedText> {
    if (file.format === 'MD' || file.format === 'TXT') return convertText(file);
    const { url, token } = converterOptions(this.env);
    const abort = AbortSignal.any([
      AbortSignal.timeout(LOCAL_CONVERTER.timeoutMs),
      ...(signal ? [signal] : []),
    ]);
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/octet-stream',
          'X-Source-Format': file.format,
          'X-Source-Sha256': file.sha256,
        },
        body: new Uint8Array(file.bytes),
        redirect: 'error',
        signal: abort,
      });
    } catch {
      throw new UploadError(
        'converter_unavailable',
        'Converter tidak tersedia atau melewati batas waktu. Tidak ada draft yang diterbitkan.',
        503,
      );
    }
    const raw = await readBoundedBytes(
      new Request('http://localhost', {
        method: 'POST',
        body: response.body,
        duplex: 'half',
        signal: abort,
      } as RequestInit),
      LOCAL_CONVERTER.maxResponseBytes,
      5000,
    );
    let value: unknown;
    try {
      value = JSON.parse(Buffer.from(raw).toString('utf8'));
    } catch {
      throw new UploadError('converter_invalid', 'Respons converter tidak valid.', 503);
    }
    if (response.status === 503)
      throw new UploadError(
        'converter_busy',
        'Converter sibuk atau belum siap. Coba lagi.',
        503,
        1,
      );
    if (!response.ok) {
      const code = (value as { code?: unknown })?.code;
      const messages: Record<string, string> = {
        encrypted: 'Berkas terenkripsi tidak didukung.',
        unsafe_archive: 'Office berisi arsip/relasi yang tidak aman.',
        empty_text: 'Tidak ditemukan teks. PDF pindai/OCR belum didukung.',
        complexity: 'Berkas melewati batas kompleksitas konversi.',
        invalid_file: 'Berkas rusak atau tidak sesuai format.',
        active_content: 'Berkas memiliki konten aktif/macro/lampiran yang tidak didukung.',
        missing_cached_value:
          'Formula XLSX tidak memiliki nilai cache. Simpan nilai di aplikasi spreadsheet lebih dulu.',
      };
      throw new UploadError(
        'conversion_failed',
        typeof code === 'string' && messages[code]
          ? messages[code]
          : 'Konversi gagal; periksa berkas dan coba kembali.',
        422,
      );
    }
    return validateConversionResponse(value, file);
  }
}
export function validateConversionResponse(value: unknown, file: UploadFile): ConvertedText {
  const bad = () =>
    new UploadError('converter_integrity', 'Hasil converter tidak cocok dengan sumber.', 503);
  if (!value || typeof value !== 'object') throw bad();
  const v = value as Record<string, unknown>;
  if (
    v.pipeline !== 'canonical-v2' ||
    v.sourceHash !== file.sha256 ||
    typeof v.markdown !== 'string' ||
    !v.markdown.trim() ||
    Buffer.byteLength(v.markdown) > 2 * 1024 * 1024 ||
    !Array.isArray(v.mappings) ||
    v.mappings.length < 1 ||
    v.mappings.length > 20000 ||
    !Array.isArray(v.warnings) ||
    v.warnings.length > 100
  )
    throw bad();
  const hash = digest(v.markdown);
  if (
    typeof v.markdownHash !== 'string' ||
    !/^([0-9a-f]{64})$/.test(v.markdownHash) ||
    !timingSafeEqual(Buffer.from(hash), Buffer.from(v.markdownHash))
  )
    throw bad();
  const lineCount = v.markdown.split('\n').length;
  const mappings = v.mappings.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object') throw bad();
    const m = entry as Record<string, unknown>;
    if (
      !['page', 'paragraph', 'table', 'sheet'].includes(String(m.kind)) ||
      typeof m.locator !== 'string' ||
      m.locator.length > 200 ||
      !Number.isInteger(m.markdownStart) ||
      !Number.isInteger(m.markdownEnd) ||
      Number(m.markdownStart) < 1 ||
      Number(m.markdownEnd) > lineCount ||
      Number(m.markdownEnd) < Number(m.markdownStart)
    )
      throw bad();
    return {
      kind: m.kind as string,
      locator: m.locator,
      markdownStart: Number(m.markdownStart),
      markdownEnd: Number(m.markdownEnd),
    };
  });
  if (v.warnings.some((x) => typeof x !== 'string' || x.length > 300)) throw bad();
  return {
    markdown: Buffer.from(v.markdown),
    sha256: hash,
    lineCount,
    mapping: { sourceStart: 1, sourceEnd: 1, markdownStart: 1, markdownEnd: lineCount },
    normalizations: ['deterministic-canonical-conversion'],
    sourceMappings: mappings,
    warnings: v.warnings as string[],
    pipeline: 'canonical-v2',
  };
}
