import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DocumentBody } from '../../apps/web/src/components/document-body.tsx';
import { getOutline } from '../../apps/web/src/lib/markdown.ts';
const render = (markdown: string) =>
  renderToStaticMarkup(createElement(DocumentBody, { markdown }));
test('untrusted Markdown never emits executable HTML or remote images', () => {
  const html = render(
    '# Uji\n\n<script>alert(1)</script>\n\n<img src="https://tracking.invalid/x" onerror="alert(1)">\n\n![tracker](https://tracking.invalid/pixel)\n\n[unsafe](javascript:alert(1))\n\n<iframe src="https://evil.invalid"></iframe>',
  );
  assert(!/<script|<img|<iframe|onerror=|href="javascript:/i.test(html));
  assert(!html.includes('https://tracking.invalid'));
  assert(html.includes('Gambar tidak dimuat'));
});
test('outline and rendered anchors share parsed IDs, even with inline formatting and duplicates', () => {
  const md =
    '## **Akses** [data](https://example.test)\n\n## **Akses** [data](https://example.test)\n\n```md\n## Bukan heading\n```';
  const outline = getOutline(md);
  assert.deepEqual(
    outline.map((x) => x.id),
    ['user-content-akses-data', 'user-content-akses-data-1'],
  );
  const html = render(md);
  for (const h of outline) assert(html.includes(`id="${h.id}"`));
});
test('external links are deliberate user navigation with no referrer or opener', () => {
  const html = render('[Dokumentasi](https://example.test)');
  assert(html.includes('rel="noopener noreferrer"'));
  assert(html.includes('target="_blank"'));
});
