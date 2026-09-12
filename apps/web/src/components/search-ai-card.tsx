'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { RetrievalScope } from '@intradocs/core/rag';
import { Icon } from './icon';
import type { AssistantCitation } from './assistant-chat';

interface Retrieval {
  citations: AssistantCitation[];
  rejected: number;
  scope: number;
}

const CLASSIFICATION_LABELS: Record<string, string> = {
  public: 'Publik',
  internal: 'Internal',
  restricted: 'Terbatas',
  confidential: 'Rahasia',
};

/**
 * The retrieval half of the assistant, placed above lexical results (mockup S02).
 *
 * It calls the retrieval-only endpoint: validated sources with their snippets, never a
 * composed answer, and nothing is stored. That keeps the card fast enough to run on
 * every search (p95 under a second on this stack) and keeps generation -- the slow and
 * memory-hungry part -- behind an explicit question on the assistant page.
 */
// Mounted with a key of query+category by the page, so a new search starts from the
// pending state by remounting rather than by resetting state inside the effect.
export function SearchAiCard({ query, categoryId }: { query: string; categoryId: string | null }) {
  const [state, setState] = useState<
    { kind: 'pending' } | { kind: 'ok'; data: Retrieval } | { kind: 'error'; message: string }
  >({ kind: 'pending' });

  useEffect(() => {
    const controller = new AbortController();
    const scope: RetrievalScope = categoryId ? { type: 'category', categoryId } : { type: 'all' };
    fetch('/api/rag/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: query, scope }),
      signal: controller.signal,
      cache: 'no-store',
    })
      .then(async (response) => {
        const body: unknown = await response.json();
        if (!response.ok) {
          const message =
            body &&
            typeof body === 'object' &&
            typeof (body as { error?: unknown }).error === 'string'
              ? (body as { error: string }).error
              : 'Retrieval gagal.';
          setState({ kind: 'error', message });
          return;
        }
        setState({ kind: 'ok', data: body as Retrieval });
      })
      .catch((e: unknown) => {
        if ((e as Error).name !== 'AbortError')
          setState({ kind: 'error', message: 'Tidak dapat menghubungi layanan lokal.' });
      });
    return () => controller.abort();
  }, [query, categoryId]);

  return (
    <section className="search-ai-card" aria-live="polite" aria-busy={state.kind === 'pending'}>
      <div className="search-ai-head">
        <Icon name="spark" size={16} />
        Sumber yang relevan menurut AI
        <span className="pill p-green">retrieval lokal</span>
      </div>
      {state.kind === 'pending' && <p className="sub">Mencari potongan dokumen yang relevan…</p>}
      {state.kind === 'error' && (
        <p className="callout c-warn" role="alert">
          <Icon name="alert" size={16} />
          <span>{state.message}</span>
        </p>
      )}
      {state.kind === 'ok' && state.data.citations.length === 0 && (
        <p className="sub">
          Tidak ada potongan dokumen dalam cakupan akses Anda yang cukup relevan dengan pertanyaan
          ini. Hasil lexical di bawah tetap ditampilkan.
        </p>
      )}
      {state.kind === 'ok' && state.data.citations.length > 0 && (
        <>
          <ol className="rag-sources">
            {state.data.citations.map((citation) => (
              <li key={`${citation.versionId}-${citation.snippet.slice(0, 24)}`}>
                <Link href={citation.href} prefetch={false} className="document-title">
                  {citation.documentTitle}
                </Link>
                <div className="sub tiny">
                  {citation.categoryName} · v{citation.versionLabel} ·{' '}
                  {CLASSIFICATION_LABELS[citation.classification] ?? citation.classification}
                  {citation.heading ? ` · ${citation.heading}` : ''}
                </div>
                <p className="rag-snippet">{citation.snippet}</p>
              </li>
            ))}
          </ol>
          <p className="sub tiny" style={{ marginTop: 10 }}>
            {state.data.scope} versi aktif dalam cakupan
            {state.data.rejected > 0
              ? ` · ${state.data.rejected} kandidat ditolak karena gagal validasi izin`
              : ''}
            {' · '}
            <Link href={`/ai-assistant?q=${encodeURIComponent(query)}`}>
              Minta jawaban tersusun di AI Assistant
            </Link>
          </p>
        </>
      )}
    </section>
  );
}
