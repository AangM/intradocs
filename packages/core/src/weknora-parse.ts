import { digest, UploadError, type UploadFile, type ConvertedText } from './uploads.ts';
import type { DocumentConverter } from './converter.ts';
import { WeknoraClient, WeknoraError } from './weknora.ts';

/**
 * WeKnora's in-process document parser used as a converter for formats the local
 * converter does not handle (PPTX today), measured in docs/WEKNORA.md §27. The file
 * goes into a knowledge base of its own ("intradocs-parse": no summary, no question
 * generation, no auto-tag, one 4000-character chunk per document), the parsed text is
 * read back, and the record is deleted -- whether or not conversion succeeded. Nothing
 * stays behind in WeKnora, the production knowledge base never sees a draft, and the
 * Markdown produced here still goes through scan, preview, review and approval like
 * any other upload: what gets indexed later is what a reviewer approved.
 *
 * Scanned PDFs (images) are NOT covered: OCR lives in WeKnora's separate docreader
 * service (~4 GB), which does not fit beside WeKnora on the reference laptop.
 */
export const WEKNORA_PARSE_FORMATS = ['PPTX'] as const;
export const WEKNORA_PARSE_PIPELINE = 'weknora-parse-v1';
export const PARSE_KNOWLEDGE_BASE_NAME = 'intradocs-parse';

export interface ParsedChunk {
  chunkIndex: number;
  content: string;
}

/** The chunks WeKnora produced, in order, as one Markdown document. */
export function assembleParsedMarkdown(chunks: readonly ParsedChunk[]): string {
  const text = [...chunks]
    .sort((a, b) => a.chunkIndex - b.chunkIndex)
    .map((c) => c.content.replace(/\r\n?/g, '\n').trim())
    .filter(Boolean)
    .join('\n\n');
  return `${text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()}\n`;
}

/**
 * One locator per slide: WeKnora renders each slide's title as a level-2 heading, so a
 * heading opens a new "page". Text before the first heading (rare) is page 1 as well.
 */
export function slideMappings(
  markdown: string,
): Array<{ kind: 'page'; locator: string; markdownStart: number; markdownEnd: number }> {
  const lines = markdown.split('\n');
  const starts: number[] = [];
  lines.forEach((line, i) => {
    if (/^##\s+\S/.test(line)) starts.push(i + 1);
  });
  if (starts.length === 0 || starts[0] !== 1) starts.unshift(1);
  const out: Array<{ kind: 'page'; locator: string; markdownStart: number; markdownEnd: number }> =
    [];
  const total = lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
  starts.forEach((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1]! - 1 : total;
    if (end >= start)
      out.push({
        kind: 'page',
        locator: `slide:${i + 1}`,
        markdownStart: start,
        markdownEnd: Math.max(start, end),
      });
  });
  return out;
}

export function toConvertedText(markdown: string): ConvertedText {
  if (!markdown.trim())
    throw new UploadError(
      'conversion_failed',
      'Tidak ditemukan teks pada berkas. Slide berisi gambar saja belum didukung (OCR).',
      422,
    );
  const bytes = Buffer.from(markdown);
  if (bytes.length > 2 * 1024 * 1024)
    throw new UploadError('conversion_failed', 'Canonical maksimal 2 MiB.', 422);
  const lineCount = markdown.split('\n').length;
  return {
    markdown: bytes,
    sha256: digest(markdown),
    lineCount,
    mapping: { sourceStart: 1, sourceEnd: 1, markdownStart: 1, markdownEnd: lineCount },
    normalizations: ['weknora-in-process-parser', 'slide-titles-as-headings'],
    sourceMappings: slideMappings(markdown),
    warnings: [
      'Teks diekstraksi oleh parser WeKnora; tata letak slide, gambar, dan catatan pembicara tidak dipertahankan.',
    ],
    pipeline: WEKNORA_PARSE_PIPELINE,
  };
}

export class WeknoraParseConverter implements DocumentConverter {
  private kbId: string | null = null;
  private readonly client: WeknoraClient;
  private readonly fallback: DocumentConverter;
  private readonly timeoutMs: number;
  // Explicit fields, not parameter properties: Node's strip-only TypeScript loader (the
  // unit tests run under `node --test`) refuses the shorthand.
  constructor(client: WeknoraClient, fallback: DocumentConverter, timeoutMs = 90_000) {
    this.client = client;
    this.fallback = fallback;
    this.timeoutMs = timeoutMs;
  }

  async convert(file: UploadFile, signal?: AbortSignal): Promise<ConvertedText> {
    if (!(WEKNORA_PARSE_FORMATS as readonly string[]).includes(file.format))
      return this.fallback.convert(file, signal);
    let knowledgeId: string | null = null;
    try {
      this.kbId ??= await this.client.ensureParseKnowledgeBase(PARSE_KNOWLEDGE_BASE_NAME);
      knowledgeId = await this.client.uploadFileForParse(this.kbId, file.name, file.bytes);
      const chunks = await this.client.waitForParsedChunks(knowledgeId, this.timeoutMs, signal);
      return toConvertedText(assembleParsedMarkdown(chunks));
    } catch (error) {
      if (error instanceof UploadError) throw error;
      if (error instanceof WeknoraError)
        throw new UploadError(
          'converter_unavailable',
          'Parser WeKnora tidak tersedia atau melewati batas waktu. Tidak ada draft yang diterbitkan.',
          503,
        );
      throw error;
    } finally {
      // The parse copy never outlives the request, success or failure.
      if (knowledgeId) await this.client.deleteKnowledge(knowledgeId).catch(() => undefined);
    }
  }
}
