'use client';
import { useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { answerToMarkdown } from '@intradocs/core/answer-export';
import type { RetrievalScope } from '@intradocs/core/rag';
import { Icon } from './icon';
import { AnswerText } from './answer-text';

export interface AssistantCitation {
  documentId: string;
  versionId: string;
  documentTitle: string;
  versionLabel: string;
  classification: string;
  categoryName: string;
  snippet: string;
  heading: string | null;
  href: string;
}

interface Turn {
  id: string;
  question: string;
  mode: 'evidence-only' | 'generated';
  answer: string | null;
  abstained: boolean;
  citations: AssistantCitation[];
  rejectedCount: number;
  scopeSize: number;
  scope: RetrievalScope;
  /** Stored citations the reader can no longer open (history only). */
  hiddenCitations: number;
  /** The owner's "membantu" vote; null until cast. */
  helpful: boolean | null;
}

export interface ConversationItem {
  id: string;
  title: string;
  updatedAt: string;
  turns: number;
}

export interface ScopeCategory {
  id: string;
  parentId: string | null;
  name: string;
}

export interface ScopeDocumentItem {
  id: string;
  title: string;
  categoryName: string;
}

const CLASSIFICATION_LABELS: Record<string, string> = {
  public: 'Publik',
  internal: 'Internal',
  restricted: 'Terbatas',
  confidential: 'Rahasia',
};

type ScopeKind = RetrievalScope['type'];

async function readError(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string')
      return (body as { error: string }).error;
  } catch {
    // Non-JSON error bodies fall through to the generic message.
  }
  return 'Permintaan gagal.';
}

export function AssistantChat({
  maxQuestionChars,
  generating = false,
  external = false,
  starters = [],
  categories,
  recentDocuments,
  initialConversations,
  initialQuestion = '',
  initialDocumentId = '',
}: {
  maxQuestionChars: number;
  generating?: boolean;
  /** Answers are composed by a provider on the internet, not on this machine. */
  external?: boolean;
  /** Example questions; a click asks them as-is. What they return still depends on scope. */
  starters?: readonly string[];
  /** Categories the actor can see; the "kategori tertentu" scope picks one of these. */
  categories: readonly ScopeCategory[];
  /** Documents the actor has opened; the "dokumen yang saya buka" scope picks from these. */
  recentDocuments: readonly ScopeDocumentItem[];
  initialConversations: readonly ConversationItem[];
  /** Pre-filled into the composer (e.g. handed over from search); never auto-sent. */
  initialQuestion?: string;
  /** Pre-selects the documents scope on this one document, if it is in recentDocuments. */
  initialDocumentId?: string;
}) {
  const fieldId = useId();
  const scopeId = useId();
  const [question, setQuestion] = useState(initialQuestion);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationItem[]>([...initialConversations]);
  const [loadingConversation, setLoadingConversation] = useState<string | null>(null);
  const [copiedTurn, setCopiedTurn] = useState<string | null>(null);
  const handedDocument = recentDocuments.some((d) => d.id === initialDocumentId);
  const [scopeKind, setScopeKind] = useState<ScopeKind>(handedDocument ? 'documents' : 'all');
  const [categoryId, setCategoryId] = useState<string>(categories[0]?.id ?? '');
  const [documentIds, setDocumentIds] = useState<string[]>(() =>
    handedDocument ? [initialDocumentId] : recentDocuments.slice(0, 3).map((d) => d.id),
  );
  // Starters generated at ingest for the versions inside the chosen scope. Fetched only
  // for a narrowed scope: the whole-corpus starters stay the curated ones.
  const [generated, setGenerated] = useState<Array<{ question: string; documentTitle: string }>>(
    [],
  );
  const scopeKey =
    scopeKind === 'category'
      ? `category:${categoryId}`
      : scopeKind === 'documents'
        ? `documents:${[...documentIds].sort().join(',')}`
        : 'all';
  useEffect(() => {
    if (scopeKey === 'all' || scopeKey.endsWith(':')) return;
    const controller = new AbortController();
    const scope: RetrievalScope = scopeKey.startsWith('category:')
      ? { type: 'category', categoryId: scopeKey.slice('category:'.length) }
      : { type: 'documents', documentIds: scopeKey.slice('documents:'.length).split(',') };
    fetch('/api/rag/suggested-questions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope }),
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) return;
        const body = (await response.json()) as {
          questions: Array<{ question: string; documentTitle: string }>;
        };
        setGenerated(body.questions);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [scopeKey]);
  const starterList: Array<{ question: string; documentTitle?: string }> =
    scopeKind === 'all' || generated.length === 0
      ? starters.map((question) => ({ question }))
      : generated;
  const abort = useRef<AbortController | null>(null);
  const threadEnd = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    threadEnd.current?.scrollIntoView({ block: 'nearest' });
  }, [turns.length, pending]);

  function currentScope(): RetrievalScope | null {
    if (scopeKind === 'category') {
      if (!categoryId) {
        setError('Pilih satu kategori.');
        return null;
      }
      return { type: 'category', categoryId };
    }
    if (scopeKind === 'documents') {
      if (documentIds.length === 0) {
        setError('Pilih minimal satu dokumen yang pernah Anda buka.');
        return null;
      }
      return { type: 'documents', documentIds };
    }
    return { type: 'all' };
  }

  async function ask(text: string) {
    const trimmed = text.trim();
    if (!trimmed || pending) return;
    const scope = currentScope();
    if (!scope) return;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setPending(true);
    setError(null);
    try {
      const response = await fetch('/api/rag/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // The question, a narrowing scope, and which of my threads to append to. The
        // knowledge base, prompt and model are chosen on the server; sending them from
        // here would not be honoured anyway.
        body: JSON.stringify({ question: trimmed, scope, conversationId }),
        signal: controller.signal,
        cache: 'no-store',
      });
      if (!response.ok) {
        setError(await readError(response));
        return;
      }
      const body = (await response.json()) as Omit<
        Turn,
        'id' | 'question' | 'scope' | 'hiddenCitations' | 'helpful'
      > & {
        conversationId: string;
        turnId: string;
      };
      const turn: Turn = {
        id: body.turnId,
        question: trimmed,
        scope,
        hiddenCitations: 0,
        helpful: null,
        mode: body.mode,
        answer: body.answer,
        abstained: body.abstained,
        citations: body.citations,
        rejectedCount: body.rejectedCount,
        scopeSize: body.scopeSize,
      };
      setTurns((list) => [...list, turn]);
      setQuestion('');
      if (conversationId !== body.conversationId) {
        setConversationId(body.conversationId);
        setConversations((list) => [
          {
            id: body.conversationId,
            title: trimmed.replace(/\s+/g, ' ').slice(0, 120),
            updatedAt: new Date().toISOString(),
            turns: 1,
          },
          ...list,
        ]);
      } else {
        setConversations((list) =>
          list.map((c) =>
            c.id === body.conversationId
              ? { ...c, turns: c.turns + 1, updatedAt: new Date().toISOString() }
              : c,
          ),
        );
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError('Tidak dapat menghubungi layanan lokal.');
    } finally {
      setPending(false);
    }
  }

  async function open(id: string) {
    if (pending || loadingConversation) return;
    setLoadingConversation(id);
    setError(null);
    try {
      const response = await fetch(`/api/rag/conversations/${id}`, { cache: 'no-store' });
      if (!response.ok) {
        setError(await readError(response));
        return;
      }
      const body = (await response.json()) as {
        id: string;
        turnList: Array<Omit<Turn, 'answer'> & { answer: string }>;
      };
      setConversationId(body.id);
      setTurns(body.turnList.map((t) => ({ ...t, answer: t.answer || null })));
    } catch {
      setError('Tidak dapat memuat percakapan.');
    } finally {
      setLoadingConversation(null);
    }
  }

  async function remove(id: string) {
    if (pending) return;
    if (!window.confirm('Hapus percakapan ini dari riwayat Anda?')) return;
    const response = await fetch(`/api/rag/conversations/${id}`, { method: 'DELETE' });
    if (!response.ok) {
      setError(await readError(response));
      return;
    }
    setConversations((list) => list.filter((c) => c.id !== id));
    if (conversationId === id) startNew();
  }

  async function vote(turnId: string, helpful: boolean) {
    const response = await fetch('/api/rag/answer-feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ turnId, helpful }),
    });
    if (!response.ok) {
      setError(await readError(response));
      return;
    }
    setTurns((list) => list.map((t) => (t.id === turnId ? { ...t, helpful } : t)));
  }

  function startNew() {
    abort.current?.abort();
    setConversationId(null);
    setTurns([]);
    setError(null);
    setQuestion('');
  }

  const scopeSummary =
    scopeKind === 'all'
      ? 'Seluruh dokumen yang boleh Anda baca'
      : scopeKind === 'category'
        ? `Kategori: ${categories.find((c) => c.id === categoryId)?.name ?? '—'}`
        : `${documentIds.length} dokumen yang pernah Anda buka`;

  return (
    <div className="assistant-layout">
      <aside className="assistant-side" aria-label="Riwayat dan cakupan">
        <button type="button" className="btn btn-p assistant-new" onClick={startNew}>
          <Icon name="plus" size={15} />
          Percakapan baru
        </button>

        <h2 className="filter-title">PERCAKAPAN</h2>
        {conversations.length === 0 ? (
          <p className="sub tiny">Belum ada percakapan tersimpan.</p>
        ) : (
          <ul className="conv-list">
            {conversations.map((c) => (
              <li key={c.id} className={c.id === conversationId ? 'on' : ''}>
                <button
                  type="button"
                  className="conv-open"
                  onClick={() => void open(c.id)}
                  aria-current={c.id === conversationId ? 'true' : undefined}
                  disabled={loadingConversation !== null}
                >
                  <span className="conv-title">{c.title}</span>
                  <span className="sub tiny">
                    {c.turns} pertanyaan · {formatWhen(c.updatedAt)}
                  </span>
                </button>
                <button
                  type="button"
                  className="conv-delete"
                  aria-label={`Hapus percakapan: ${c.title}`}
                  onClick={() => void remove(c.id)}
                >
                  <Icon name="x" size={13} />
                </button>
              </li>
            ))}
          </ul>
        )}

        <h2 className="filter-title mt20" id={scopeId}>
          RUANG LINGKUP JAWABAN
        </h2>
        <div className="scope-picker" role="radiogroup" aria-labelledby={scopeId}>
          <label>
            <input
              type="radio"
              name="scope"
              checked={scopeKind === 'all'}
              onChange={() => setScopeKind('all')}
            />
            Seluruh knowledge base
          </label>
          <label>
            <input
              type="radio"
              name="scope"
              checked={scopeKind === 'category'}
              onChange={() => setScopeKind('category')}
              disabled={categories.length === 0}
            />
            Kategori tertentu saja
          </label>
          {scopeKind === 'category' && (
            <select
              className="inp"
              aria-label="Kategori"
              value={categoryId}
              onChange={(event) => setCategoryId(event.target.value)}
            >
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.parentId ? '— ' : ''}
                  {c.name}
                </option>
              ))}
            </select>
          )}
          <label>
            <input
              type="radio"
              name="scope"
              checked={scopeKind === 'documents'}
              onChange={() => setScopeKind('documents')}
              disabled={recentDocuments.length === 0}
            />
            Dokumen yang saya buka
          </label>
          {scopeKind === 'documents' && (
            <ul className="scope-docs">
              {recentDocuments.map((d) => (
                <li key={d.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={documentIds.includes(d.id)}
                      onChange={(event) =>
                        setDocumentIds((ids) =>
                          event.target.checked
                            ? [...ids, d.id].slice(0, 20)
                            : ids.filter((x) => x !== d.id),
                        )
                      }
                    />
                    <span>
                      {d.title}
                      <span className="sub tiny"> · {d.categoryName}</span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          {recentDocuments.length === 0 && (
            <p className="sub tiny">Buka sebuah dokumen dulu agar bisa dipilih di sini.</p>
          )}
        </div>
        <p className="callout c-info assistant-note" role="note">
          <Icon name="shield" size={15} />
          <span>
            Asisten hanya menjawab dari dokumen final-approved yang boleh Anda baca. Cakupan
            mempersempit, tidak pernah memperluas. Bila tidak ada bukti, ia berkata tidak tahu.
          </span>
        </p>
      </aside>

      <section className="assistant-main">
        {turns.length === 0 && !pending && (
          <div className="chat-welcome">
            <span className="logo-mark">
              <Icon name="spark" size={25} />
            </span>
            <h2>Apa yang ingin Anda ketahui?</h2>
            <p className="sub">
              Jawaban hanya disusun dari dokumen final-approved yang boleh Anda baca. Tanpa sumber
              sah, IntraDocs menyatakan tidak tahu.
            </p>
            {external && (
              <p className="callout c-warn" role="note">
                <Icon name="globe" size={16} />
                <span>
                  Penyusunan jawaban memakai provider di internet. Pertanyaan Anda dan potongan
                  dokumen yang terpilih dikirim ke luar mesin ini. Jangan gunakan untuk dokumen
                  nyata atau rahasia.
                </span>
              </p>
            )}
          </div>
        )}

        <div className="assistant-thread" aria-live="polite" aria-busy={pending}>
          {turns.map((turn, index) => (
            <article className="turn" key={turn.id}>
              <div className="turn-q">
                <span className="turn-who">Anda</span>
                <p>{turn.question}</p>
                <span className="sub tiny">{describeScope(turn.scope, categories)}</span>
              </div>
              <div className="turn-a">
                <span className="turn-who">IntraDocs AI</span>
                {turn.hiddenCitations > 0 && (
                  <p className="callout c-warn" role="note">
                    <Icon name="lock" size={15} />
                    <span>
                      {turn.hiddenCitations} sumber jawaban ini tidak lagi boleh Anda baca, jadi
                      teks jawabannya disembunyikan. Ajukan pertanyaannya lagi untuk jawaban dari
                      sumber yang berlaku sekarang.
                    </span>
                  </p>
                )}
                {turn.answer && (
                  <div className="rag-answer">
                    <AnswerText text={turn.answer} />
                  </div>
                )}
                {turn.abstained && !turn.answer && (
                  <p className="rag-answer">
                    Tidak ada sumber resmi dalam cakupan akses Anda yang menjawab pertanyaan ini.
                  </p>
                )}
                {turn.citations.length > 0 && (
                  <>
                    <h3 className="rag-sources-title">Sumber ({turn.citations.length})</h3>
                    <ol className="rag-sources">
                      {turn.citations.map((citation) => (
                        <li key={`${citation.versionId}-${citation.snippet.slice(0, 24)}`}>
                          <Link href={citation.href} prefetch={false} className="document-title">
                            {citation.documentTitle}
                          </Link>
                          <div className="sub tiny">
                            {citation.categoryName} · v{citation.versionLabel} ·{' '}
                            {CLASSIFICATION_LABELS[citation.classification] ??
                              citation.classification}
                            {citation.heading ? ` · ${citation.heading}` : ''}
                          </div>
                          <p className="rag-snippet">{citation.snippet}</p>
                        </li>
                      ))}
                    </ol>
                  </>
                )}
                <p className="sub tiny">
                  Cakupan retrieval: {turn.scopeSize} versi aktif yang boleh Anda baca.
                  {turn.rejectedCount > 0
                    ? ` ${turn.rejectedCount} kandidat ditolak validasi (izin atau teks buatan mesin).`
                    : ''}
                </p>
                {/* Built from what is already on screen -- the citations that survived
                    validation -- so exporting opens no path to anything else. */}
                {(turn.answer || turn.citations.length > 0) && (
                  <div className="rag-export">
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => {
                        void navigator.clipboard
                          ?.writeText(markdown(turn))
                          .then(() => setCopiedTurn(turn.id))
                          .catch(() => setCopiedTurn(null));
                      }}
                    >
                      <Icon name="file" size={14} />
                      {copiedTurn === turn.id ? 'Tersalin' : 'Salin sebagai Markdown'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => download(markdown(turn), turn.question)}
                    >
                      <Icon name="download" size={14} />
                      Unduh .md
                    </button>
                    {index === turns.length - 1 && (
                      <span className="sub tiny">
                        Tautan sumber tetap mengarah ke IntraDocs dan tetap memeriksa izin saat
                        dibuka.
                      </span>
                    )}
                  </div>
                )}
                {/* One vote per answer, on the stored turn. An unhelpful vote also counts as
                    a knowledge-gap signal, like a search that found nothing. */}
                <div className="turn-vote" role="group" aria-label="Apakah jawaban ini membantu?">
                  <span className="sub tiny">Membantu?</span>
                  <button
                    type="button"
                    className={`btn btn-sm${turn.helpful === true ? ' btn-p' : ''}`}
                    aria-pressed={turn.helpful === true}
                    onClick={() => void vote(turn.id, true)}
                  >
                    <Icon name="thumb" size={13} />
                    Ya
                  </button>
                  <button
                    type="button"
                    className={`btn btn-sm${turn.helpful === false ? ' btn-p' : ''}`}
                    aria-pressed={turn.helpful === false}
                    onClick={() => void vote(turn.id, false)}
                  >
                    <Icon name="thumb" size={13} className="flip" />
                    Tidak
                  </button>
                  {turn.helpful === false && (
                    <span className="sub tiny">Dicatat sebagai kebutuhan pengetahuan.</span>
                  )}
                </div>
              </div>
            </article>
          ))}
          {pending && (
            <p className="sub turn-pending">
              Mengambil kandidat dan memvalidasi izin sumber…
              {generating
                ? ' Model bahasa berjalan lokal di CPU, jadi jawaban bisa memakan puluhan detik.'
                : ''}
            </p>
          )}
          {error && (
            <div className="callout c-warn" role="alert">
              <Icon name="alert" size={18} />
              <div>{error}</div>
            </div>
          )}
          <div ref={threadEnd} />
        </div>

        {starterList.length > 0 && turns.length === 0 && !pending && (
          <div className="reader-actions" aria-label="Contoh pertanyaan">
            {starterList.map((item) => (
              <button
                key={item.question}
                type="button"
                className="btn btn-sm"
                title={item.documentTitle ? `Dari: ${item.documentTitle}` : undefined}
                onClick={() => {
                  setQuestion(item.question);
                  void ask(item.question);
                }}
              >
                {item.question}
              </button>
            ))}
          </div>
        )}

        <form
          className="chat-composer"
          onSubmit={(event) => {
            event.preventDefault();
            void ask(question);
          }}
        >
          <label htmlFor={fieldId} className="sr-only">
            Pertanyaan AI
          </label>
          <textarea
            id={fieldId}
            value={question}
            maxLength={maxQuestionChars}
            disabled={pending}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void ask(question);
              }
            }}
            placeholder={
              turns.length
                ? 'Pertanyaan lanjutan… (setiap pertanyaan dicari ulang dari dokumen)'
                : 'Tanyakan sesuatu tentang dokumen yang boleh Anda baca…'
            }
          />
          <footer>
            <span className="sub tiny">
              {scopeSummary} · sumber divalidasi ulang pada setiap permintaan · maksimal{' '}
              {maxQuestionChars} karakter.
            </span>
            <button className="btn btn-p" type="submit" disabled={pending || !question.trim()}>
              <Icon name="arrow-r" size={16} />
              {pending ? 'Mencari…' : 'Kirim'}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

function describeScope(scope: RetrievalScope, categories: readonly ScopeCategory[]): string {
  if (scope.type === 'category')
    return `Cakupan: kategori ${categories.find((c) => c.id === scope.categoryId)?.name ?? '(tidak lagi terlihat)'}`;
  if (scope.type === 'documents')
    return `Cakupan: ${scope.documentIds.length} dokumen yang pernah dibuka`;
  return 'Cakupan: seluruh dokumen yang boleh dibaca';
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
}

function markdown(turn: Turn): string {
  return answerToMarkdown({
    question: turn.question,
    answer: turn.answer,
    abstained: turn.abstained,
    citations: turn.citations,
    origin: window.location.origin,
  });
}

function download(text: string, question: string) {
  const slug =
    question
      .slice(0, 40)
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-|-$/g, '') || 'jawaban';
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `intradocs-${slug}.md`;
  link.click();
  URL.revokeObjectURL(url);
}
