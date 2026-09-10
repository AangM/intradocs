// Rendering one answer as Markdown the reader can keep.
//
// Deliberately its own module with no Node imports: this runs in the browser, and
// packages/core/src/rag.ts pulls in node:crypto for export hashing, which would break
// the client bundle if this lived there.
import { ABSTAIN_MESSAGE } from './rag-messages.ts';

export interface ExportableCitation {
  documentTitle: string;
  versionLabel: string;
  classification: string;
  categoryName: string;
  heading: string | null;
  snippet: string;
  href: string;
}

/**
 * Renders one answer and its sources as Markdown the reader can keep.
 *
 * Everything here was already validated and shown on screen, so no new authorisation
 * question arises. Two things still matter in the output itself. Links are written with
 * the origin the caller supplies rather than a bare path, because a copied document is
 * useless if its citations do not resolve -- and they stay pointing at IntraDocs, which
 * still checks permission when opened. And the document's own text is fenced rather than
 * interpolated, so a snippet containing Markdown or an image reference cannot restructure
 * the exported file or make it fetch anything when rendered elsewhere.
 */
export function answerToMarkdown(input: {
  question: string;
  answer: string | null;
  abstained: boolean;
  citations: readonly ExportableCitation[];
  origin: string;
  generatedAt?: Date;
}): string {
  const stamp = (input.generatedAt ?? new Date()).toISOString();
  const lines: string[] = [
    `# ${oneLine(input.question)}`,
    '',
    `> Diekspor dari IntraDocs pada ${stamp}.`,
    '> Jawaban hanya berlaku untuk sumber yang tercantum dan izin Anda saat itu.',
    '',
  ];
  if (input.abstained || !input.citations.length) {
    lines.push(ABSTAIN_MESSAGE, '');
  } else {
    if (input.answer && input.answer.trim()) lines.push(input.answer.trim(), '');
    else
      lines.push(
        'Mode retrieval-only: tidak ada jawaban yang disusun model. Sumber di bawah adalah bukti yang cocok.',
        '',
      );
    lines.push(`## Sumber (${input.citations.length})`, '');
    input.citations.forEach((c, index) => {
      const where = c.heading ? ` · ${oneLine(c.heading)}` : '';
      lines.push(
        `${index + 1}. **${oneLine(c.documentTitle)}** — v${oneLine(c.versionLabel)} · ${oneLine(
          c.categoryName,
        )} · ${oneLine(c.classification)}${where}`,
        `   <${absolute(input.origin, c.href)}>`,
        '',
        // Fenced, not inlined: document text is data here exactly as it is everywhere else.
        '   ```text',
        ...c.snippet.split('\n').map((l) => `   ${l.replace(/```/g, "'''")}`),
        '   ```',
        '',
      );
    });
  }
  return lines.join('\n');
}

function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}
function absolute(origin: string, href: string): string {
  try {
    return new URL(href, origin).href;
  } catch {
    return href;
  }
}
