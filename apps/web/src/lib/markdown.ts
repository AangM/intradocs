import { unified, type Plugin } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type { Root } from 'mdast';
import { headingSlug } from '@intradocs/core/validation';
type Node = {
  type: string;
  value?: string;
  depth?: number;
  children?: Node[];
  data?: { hProperties?: Record<string, unknown> };
};
export type OutlineItem = { id: string; label: string; level: number };
function text(n: Node): string {
  return n.value ?? n.children?.map(text).join('') ?? '';
}
function annotate(tree: Node): OutlineItem[] {
  const used = new Map<string, number>();
  const outline: OutlineItem[] = [];
  function walk(n: Node) {
    if (n.type === 'heading' && (n.depth === 2 || n.depth === 3)) {
      const label = text(n),
        base = headingSlug(label),
        count = used.get(base) ?? 0;
      used.set(base, count + 1);
      const id = count ? `${base}-${count}` : base;
      n.data ??= {};
      n.data.hProperties = { ...n.data.hProperties, id };
      outline.push({ id: `user-content-${id}`, label, level: n.depth });
    }
    n.children?.forEach(walk);
  }
  walk(tree);
  return outline;
}
export function getOutline(markdown: string): OutlineItem[] {
  return annotate(unified().use(remarkParse).use(remarkGfm).parse(markdown) as Node);
}
export const remarkHeadingIds: Plugin<[], Root> = function () {
  return (tree) => {
    annotate(tree as Node);
  };
};

export function firstHeadingMatches(markdown: string, title: string): boolean {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown) as Node;
  const first = tree.children?.[0];
  return first?.type === 'heading' && first.depth === 1 && text(first).trim() === title.trim();
}
