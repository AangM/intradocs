import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import { safeLink } from '@intradocs/core/validation';
import { remarkHeadingIds, firstHeadingMatches } from '@/lib/markdown';
export function DocumentBody({ markdown, title }: { markdown: string; title?: string }) {
  return (
    <div
      className={`markdown-body ${title && firstHeadingMatches(markdown, title) ? 'hide-duplicate-title' : ''}`}
    >
      <Markdown
        skipHtml
        remarkPlugins={[remarkGfm, remarkHeadingIds]}
        rehypePlugins={[rehypeSanitize]}
        components={{
          a: ({ href, children }) => {
            const safe = safeLink(href);
            if (!safe) return <span>{children}</span>;
            const external = /^https?:/.test(safe);
            return (
              <a
                href={safe}
                target={external ? '_blank' : undefined}
                rel={external ? 'noopener noreferrer' : undefined}
              >
                {children}
              </a>
            );
          },
          img: ({ alt }) => (
            <span className="image-blocked">
              Gambar tidak dimuat pada M2a{alt ? `: ${alt}` : ''}. Asset terotorisasi belum
              diimplementasikan.
            </span>
          ),
        }}
      >
        {markdown}
      </Markdown>
    </div>
  );
}
