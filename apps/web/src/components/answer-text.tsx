import type { ReactNode } from 'react';

/**
 * Renders an assistant answer as readable text: paragraphs, bullet and numbered lists,
 * bold and inline code. Deliberately not a Markdown engine -- no links, images, HTML or
 * headings -- because the answer is model output. Everything is emitted as text nodes,
 * so nothing in it can ever become markup.
 */
export function AnswerText({ text }: { text: string }) {
  const blocks = splitBlocks(text);
  return (
    <div className="answer-text">
      {blocks.map((block, i) => {
        if (block.kind === 'ul')
          return (
            <ul key={i}>
              {block.items.map((item, j) => (
                <li key={j}>{inline(item)}</li>
              ))}
            </ul>
          );
        if (block.kind === 'ol')
          return (
            <ol key={i}>
              {block.items.map((item, j) => (
                <li key={j}>{inline(item)}</li>
              ))}
            </ol>
          );
        if (block.kind === 'quote')
          return (
            <blockquote key={i} className="answer-quote">
              {inline(block.text)}
            </blockquote>
          );
        return <p key={i}>{inline(block.text)}</p>;
      })}
    </div>
  );
}

type Block =
  | { kind: 'p'; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[] };

function splitBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ kind: 'p', text: paragraph.join(' ') });
    paragraph = [];
  };
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const line = raw.replace(/^\s{0,3}#{1,6}\s+/, '').trim();
    if (!line) {
      flush();
      continue;
    }
    const quoted = /^>\s?(.*)$/.exec(line);
    if (quoted) {
      flush();
      const last = blocks[blocks.length - 1];
      if (last && last.kind === 'quote') last.text += ` ${quoted[1]}`;
      else blocks.push({ kind: 'quote', text: quoted[1]! });
      continue;
    }
    const bullet = /^[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flush();
      const kind = bullet ? 'ul' : 'ol';
      const item = (bullet ?? numbered)![1]!;
      const last = blocks[blocks.length - 1];
      if (last && last.kind === kind) last.items.push(item);
      else blocks.push({ kind, items: [item] });
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return blocks;
}

/** `**bold**` and `` `code` `` only; everything else is plain text. */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let k = 0;
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) out.push(text.slice(last, match.index));
    const token = match[0];
    if (token.startsWith('**')) out.push(<strong key={k++}>{token.slice(2, -2)}</strong>);
    else out.push(<code key={k++}>{token.slice(1, -1)}</code>);
    last = match.index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
