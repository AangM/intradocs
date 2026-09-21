import { mutation } from '@/lib/mutation';
import { hasCapability } from '@intradocs/core';
import { InputError, parseUuid } from '@intradocs/core/validation';
import { WeknoraClient } from '@intradocs/core/weknora';
import { indexedDocument } from '@intradocs/db/insights';
import { getAiConfig } from '@/lib/rag';

const MAX_SUMMARY_CHARS = 2000;
const MAX_QUESTIONS = 5;

/**
 * What WeKnora generated about one document at ingest.
 *
 * Questions go to anyone who can read the document: they are derived from its text and
 * every click still runs through retrieval and citation validation. The summary goes
 * only to people who could act on it (documents.upload), and only as a draft: a fluent
 * but wrong summary next to an approved document is exactly the thing a reader would
 * mistake for the document's own words, so it is never shown as one. Nothing is written.
 */
export async function POST(request: Request) {
  return mutation(request, undefined, async (actor, body) => {
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new InputError('Payload tidak valid.');
    const v = body as Record<string, unknown>;
    if (Object.keys(v).join(',') !== 'documentId')
      throw new InputError('Hanya field documentId yang diizinkan.');
    const documentId = parseUuid(v.documentId);
    const off = { available: false, questions: [], summary: null, currentSummary: null };

    const config = getAiConfig();
    const weknora = config.retrieval === 'weknora-local' ? config.weknora : null;
    if (!weknora) return off;
    // Unreadable and never-indexed answer identically, so this reveals nothing.
    const indexed = await indexedDocument(actor.id, documentId);
    if (!indexed) return off;

    const generated = await new WeknoraClient(weknora).knowledgeGenerated(indexed.knowledgeId, {
      maxSummaryChars: MAX_SUMMARY_CHARS,
      maxQuestions: MAX_QUESTIONS,
    });
    const editor = hasCapability(actor, 'documents.upload');
    return {
      available: true,
      questions: generated.questions,
      summary: editor ? generated.summary : null,
      currentSummary: editor ? indexed.currentSummary : null,
    };
  });
}
