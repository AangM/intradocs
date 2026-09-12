import { mutation } from '@/lib/mutation';
import { InputError, parseUuid } from '@intradocs/core/validation';
import { parseQuestion } from '@intradocs/core/rag';
import { metadataHints } from '@intradocs/db/metadata-help';
import { getAiConfig, retrieve, AiDisabled } from '@/lib/rag';

const MAX_EXCERPT = 1500;

/**
 * "Bantuan metadata" for a draft that is not yet anywhere (mockup S05).
 *
 * The draft is a private, unreviewed file, so it is never ingested anywhere for this.
 * What leaves IntraDocs is one bounded excerpt used as a retrieval QUESTION against the
 * published corpus the actor may read -- the same trust boundary as asking the assistant
 * -- to surface possible duplicates. Label and category hints are lexical and local.
 * Nothing is stored; nothing is applied.
 */
export async function POST(request: Request) {
  return mutation(request, 'documents.upload', async (actor, body) => {
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new InputError('Payload tidak valid.');
    const v = body as Record<string, unknown>;
    for (const key of Object.keys(v))
      if (!['title', 'excerpt', 'categoryId'].includes(key))
        throw new InputError('Hanya field title, excerpt dan categoryId yang diizinkan.');
    const title = typeof v.title === 'string' ? v.title.trim().slice(0, 180) : '';
    const excerpt = typeof v.excerpt === 'string' ? v.excerpt.slice(0, 20_000) : '';
    const categoryId =
      v.categoryId === undefined || v.categoryId === null || v.categoryId === ''
        ? null
        : parseUuid(v.categoryId);
    if (!title && !excerpt) throw new InputError('Isi judul atau pilih berkas dulu.');

    const hints = await metadataHints(actor.id, `${title}\n${excerpt}`, categoryId);

    // Possible duplicates: retrieval only, on the published corpus, deduplicated by
    // document. A short excerpt behaves like a question; the whole file never travels.
    let similar: Array<{ documentId: string; title: string; categoryName: string; href: string }> =
      [];
    const config = getAiConfig();
    if (config.retrieval === 'weknora-local' && config.weknora) {
      try {
        // One line: parseQuestion rejects control characters, newlines included.
        const question = parseQuestion(
          `${title} ${excerpt}`.replace(/\s+/g, ' ').trim().slice(0, MAX_EXCERPT),
          config.weknora.maxQuestionChars,
        );
        const result = await retrieve(actor, question);
        const seen = new Set<string>();
        for (const c of result.citations) {
          if (seen.has(c.documentId)) continue;
          seen.add(c.documentId);
          similar.push({
            documentId: c.documentId,
            title: c.documentTitle,
            categoryName: c.categoryName,
            href: `/dokumen/${c.documentId}/${c.documentSlug}`,
          });
        }
        similar = similar.slice(0, 5);
      } catch (error) {
        // A disabled or unreachable assistant costs the duplicate hint, not the upload.
        if (!(error instanceof AiDisabled)) similar = [];
      }
    }
    return { ...hints, similar, aiOn: config.retrieval === 'weknora-local' };
  });
}
