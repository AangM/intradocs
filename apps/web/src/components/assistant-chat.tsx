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
  /** Documents worth opening next (catalogue answers, abstentions); live turns only. */
  related?: Array<{ documentId: string; title: string; categoryName: string; href: string }>;
  /** Questions the person can ask next; live turns only. */
  suggestions?: string[];
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
  actorName = '',
  maxQuestionChars,
  generating = false,
  external = false,
  starters = [],
  categories,
  recentDocuments,
  initialConversations,
  initialQuestion = '',
  initialDocumentId = '',
  autoAsk = false,
}: {
  /** Greets the person by first name on an empty thread. */
  actorName?: string;
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
  /** Pre-filled into the composer (e.g. handed over from search). */
  initialQuestion?: string;
  /**
   * Send initialQuestion once on mount. Only the home hero sets this: there the person
   * typed a question into a box labelled "Tanya AI" and pressed Enter, which is the
   * decision to start a (slow, local) generation; a search hand-over still waits.
   */
  autoAsk?: boolean;
  /** Pre-selects the documents scope on this one document, if it is in recentDocuments. */
  initialDocumentId?: string;
}) {
  const firstName = actorName.trim().split(/\s+/)[0] ?? '';
  const fieldId = useId();
  const scopeId = useId();
  const sideId = useId();
  const [question, setQuestion] = useState(initialQuestion);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationItem[]>([...initialConversations]);
  const [loadingConversation, setLoadingConversation] = useState<string | null>(null);
  const [copiedTurn, setCopiedTurn] = useState<string | null>(null);
  // Turns whose citation detail (every passage, with its snippet) is open.
  const [openSources, setOpenSources] = useState<ReadonlySet<string>>(() => new Set());
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

  // One auto-send per mount, and the URL is cleaned so a reload does not ask again.
  const autoAsked = useRef(false);
  useEffect(() => {
    if (!autoAsk || autoAsked.current || !initialQuestion.trim()) return;
    autoAsked.current = true;
    window.history.replaceState(null, '', '/ai-assistant');
    void ask(initialQuestion);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only by design
  }, []);

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
        related: body.related ?? [],
        suggestions: body.suggestions ?? [],
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
    <div className="chat">
      {/* The side panel folds behind the "Riwayat & cakupan" button on a phone (CSS
          checkbox, no JS); on a desktop it is always open. */}
      <input type="checkbox" id={sideId} className="sr-only chat-side-toggle" />
      <aside className="chat-side" aria-label="Riwayat dan cakupan">
        <div className="chat-side-top">
          <button type="button" className="btn btn-p chat-new" onClick={startNew}>
            <Icon name="plus" size={15} />
            Percakapan baru
          </button>
          <label htmlFor={sideId} className="icon-btn chat-side-close" aria-label="Tutup panel">
            <Icon name="x" size={16} />
          </label>
        </div>

        <div className="chat-side-lbl">Riwayat</div>
        {conversations.length === 0 ? (
          <p className="sub tiny chat-side-empty">Percakapan Anda akan tersimpan di sini.</p>
        ) : (
          <ul className="chat-convs">
            {conversations.map((c) => (
              <li key={c.id} className={c.id === conversationId ? 'on' : ''}>
                <button
                  type="button"
                  className="chat-conv"
                  onClick={() => void open(c.id)}
                  aria-current={c.id === conversationId ? 'true' : undefined}
                  disabled={loadingConversation !== null}
                  title={c.title}
                >
                  <span className="chat-conv-t">{c.title}</span>
                  <span className="chat-conv-m">
                    {c.turns} pertanyaan · {formatWhen(c.updatedAt)}
                  </span>
                </button>
                <button
                  type="button"
                  className="chat-conv-x"
                  aria-label={`Hapus percakapan: ${c.title}`}
                  title="Hapus"
                  onClick={() => void remove(c.id)}
                >
                  <Icon name="x" size={13} />
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="chat-side-lbl" id={scopeId}>
          Cakupan jawaban
        </div>
        <div className="scope-picker" role="radiogroup" aria-labelledby={scopeId}>
          <label className={`scope-opt ${scopeKind === 'all' ? 'on' : ''}`}>
            <input
              type="radio"
              name="scope"
              checked={scopeKind === 'all'}
              onChange={() => setScopeKind('all')}
            />
            <Icon name="layers" size={15} />
            <span>Semua dokumen</span>
          </label>
          <label
            className={`scope-opt ${scopeKind === 'category' ? 'on' : ''} ${categories.length === 0 ? 'off' : ''}`}
          >
            <input
              type="radio"
              name="scope"
              checked={scopeKind === 'category'}
              onChange={() => setScopeKind('category')}
              disabled={categories.length === 0}
            />
            <Icon name="folder" size={15} />
            <span>Satu kategori</span>
          </label>
          {scopeKind === 'category' && (
            <select
              className="inp scope-select"
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
          <label
            className={`scope-opt ${scopeKind === 'documents' ? 'on' : ''} ${recentDocuments.length === 0 ? 'off' : ''}`}
          >
            <input
              type="radio"
              name="scope"
              checked={scopeKind === 'documents'}
              onChange={() => setScopeKind('documents')}
              disabled={recentDocuments.length === 0}
            />
            <Icon name="book" size={15} />
            <span>Dokumen yang saya buka</span>
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
          {recentDocuments.length === 0 && scopeKind !== 'category' && (
            <p className="sub tiny chat-side-empty">
              Buka sebuah dokumen dulu untuk bertanya khusus tentangnya.
            </p>
          )}
        </div>
        <p className="chat-side-note">
          <Icon name="shield" size={14} />
          <span>
            Hanya dari dokumen yang boleh Anda baca. Tanpa sumber, asisten bilang tidak tahu.
          </span>
        </p>
      </aside>

      <section className="chat-main">
        <header className="chat-head">
          <label htmlFor={sideId} className="icon-btn chat-side-btn" aria-label="Riwayat & cakupan">
            <Icon name="list" size={18} />
          </label>
          <div className="chat-head-t">
            <strong>AI Assistant</strong>
            <span className="sub tiny">{scopeSummary}</span>
          </div>
          <span className="pill p-green chat-head-pill">
            {external ? 'Provider eksternal' : generating ? 'Berjalan lokal' : 'Sumber lokal'}
          </span>
        </header>

        <div className="chat-scroll">
          <div className="chat-col">
            {turns.length === 0 && !pending && (
              <div className="chat-hello">
                <span className="chat-orb">
                  <Icon name="spark" size={26} />
                </span>
                <h2>{firstName ? `Halo, ${firstName}. ` : ''}Ada yang bisa saya bantu?</h2>
                <p>
                  Tanyakan apa saja tentang SOP, panduan, dan kebijakan — jawabannya disusun dari
                  dokumen resmi dan selalu menyebut sumbernya.
                </p>
                {external && (
                  <p className="callout c-warn" role="note">
                    <Icon name="globe" size={16} />
                    <span>
                      Penyusunan jawaban memakai provider di internet: pertanyaan dan potongan
                      dokumen terpilih dikirim ke luar mesin ini. Jangan gunakan untuk dokumen nyata
                      atau rahasia.
                    </span>
                  </p>
                )}
                {starterList.length > 0 && (
                  <div className="chat-starters" aria-label="Contoh pertanyaan">
                    {starterList.slice(0, 4).map((item) => (
                      <button
                        key={item.question}
                        type="button"
                        className="chat-starter"
                        onClick={() => {
                          setQuestion(item.question);
                          void ask(item.question);
                        }}
                      >
                        <Icon name="spark" size={14} />
                        <span>
                          {item.question}
                          {item.documentTitle && (
                            <span className="chat-starter-doc">{item.documentTitle}</span>
                          )}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="chat-thread" aria-live="polite" aria-busy={pending}>
              {turns.map((turn) => {
                const docs = groupCitations(turn.citations);
                const detailOpen = openSources.has(turn.id);
                return (
                  <article className="turn" key={turn.id}>
                    <div className="u-msg">
                      <div className="u-bubble">{turn.question}</div>
                      {turn.scope.type !== 'all' && (
                        <span className="u-scope">{describeScope(turn.scope, categories)}</span>
                      )}
                    </div>
                    <div className="a-msg">
                      <span className="a-avatar" aria-hidden="true">
                        <Icon name="spark" size={15} />
                      </span>
                      <div className="a-body turn-a">
                        {turn.hiddenCitations > 0 && (
                          <p className="callout c-warn" role="note">
                            <Icon name="lock" size={15} />
                            <span>
                              {turn.hiddenCitations} sumber jawaban ini tidak lagi boleh Anda baca,
                              jadi teksnya disembunyikan. Tanyakan lagi untuk jawaban dari sumber
                              yang berlaku sekarang.
                            </span>
                          </p>
                        )}
                        {turn.answer && (
                          <div className="a-text">
                            <AnswerText text={turn.answer} />
                          </div>
                        )}
                        {turn.abstained && !turn.answer && (
                          <p className="a-text a-abstain">
                            <Icon name="help" size={15} />
                            {turn.related?.length
                              ? 'Tidak ada dokumen yang membahas ini secara langsung. Yang paling dekat ada di bawah — atau coba salah satu pertanyaan berikut.'
                              : 'Tidak ada dokumen yang boleh Anda baca yang membahas ini, jadi saya tidak menjawab. Coba kata lain, atau tanyakan "dokumen apa saja yang ada?".'}
                          </p>
                        )}
                        {(turn.related?.length ?? 0) > 0 && (
                          <div className="src-row">
                            <span className="src-lbl">
                              {turn.abstained ? 'Mungkin terkait' : 'Dokumen'}
                            </span>
                            {turn.related!.map((d) => (
                              <Link
                                key={d.documentId}
                                href={d.href}
                                prefetch={false}
                                className="src-chip"
                                title={`${d.title} · ${d.categoryName}`}
                              >
                                <Icon name="book" size={13} />
                                <span className="src-t">{d.title}</span>
                              </Link>
                            ))}
                          </div>
                        )}
                        {docs.length > 0 && (
                          <div className="src-row">
                            <span className="src-lbl">Sumber</span>
                            {docs.map((d, n) => (
                              <Link
                                key={d.documentId}
                                href={d.href}
                                prefetch={false}
                                className="src-chip"
                                title={`${d.documentTitle} · ${d.categoryName}`}
                              >
                                <span className="src-n">{n + 1}</span>
                                <span className="src-t">{d.documentTitle}</span>
                                {d.count > 1 && <span className="src-c">×{d.count}</span>}
                              </Link>
                            ))}
                            <button
                              type="button"
                              className="src-more"
                              aria-expanded={detailOpen}
                              onClick={() =>
                                setOpenSources((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(turn.id)) next.delete(turn.id);
                                  else next.add(turn.id);
                                  return next;
                                })
                              }
                            >
                              <Icon name="chev-d" size={13} className={detailOpen ? 'flip' : ''} />
                              {detailOpen
                                ? 'Tutup kutipan'
                                : `Lihat ${turn.citations.length} kutipan`}
                            </button>
                          </div>
                        )}
                        {docs.length > 0 && detailOpen && (
                          <ol className="src-detail">
                            {turn.citations.map((citation, n) => (
                              <li key={`${citation.versionId}-${n}`}>
                                <Link href={citation.href} prefetch={false} className="src-dt">
                                  {citation.documentTitle}
                                  {citation.heading ? ` › ${citation.heading}` : ''}
                                </Link>
                                <span className="src-dm">
                                  v{citation.versionLabel} · {citation.categoryName} ·{' '}
                                  {CLASSIFICATION_LABELS[citation.classification] ??
                                    citation.classification}
                                </span>
                                <p className="src-snip">{citation.snippet}</p>
                              </li>
                            ))}
                          </ol>
                        )}
                        {(turn.suggestions?.length ?? 0) > 0 && !pending && (
                          <div className="sugg-row" aria-label="Pertanyaan lanjutan">
                            {turn.suggestions!.map((q) => (
                              <button
                                key={q}
                                type="button"
                                className="sugg-chip"
                                onClick={() => {
                                  setQuestion(q);
                                  void ask(q);
                                }}
                              >
                                <Icon name="spark" size={12} />
                                {q}
                              </button>
                            ))}
                          </div>
                        )}
                        {/* One vote per answer, on the stored turn. An unhelpful vote also
                            counts as a knowledge-gap signal, like a search that found nothing.
                            Export is built from what is already on screen -- the validated
                            citations -- so it opens no path to anything else. */}
                        <div className="turn-actions" role="group" aria-label="Tindakan">
                          <button
                            type="button"
                            className={`ta ${turn.helpful === true ? 'on' : ''}`}
                            aria-pressed={turn.helpful === true}
                            aria-label="Membantu"
                            title="Membantu"
                            onClick={() => void vote(turn.id, true)}
                          >
                            <Icon name="thumb" size={14} />
                          </button>
                          <button
                            type="button"
                            className={`ta ${turn.helpful === false ? 'on' : ''}`}
                            aria-pressed={turn.helpful === false}
                            aria-label="Tidak membantu"
                            title="Tidak membantu"
                            onClick={() => void vote(turn.id, false)}
                          >
                            <Icon name="thumb" size={14} className="flip" />
                          </button>
                          {(turn.answer || turn.citations.length > 0) && (
                            <>
                              <button
                                type="button"
                                className="ta"
                                aria-label="Salin sebagai Markdown"
                                title={copiedTurn === turn.id ? 'Tersalin' : 'Salin Markdown'}
                                onClick={() => {
                                  void navigator.clipboard
                                    ?.writeText(markdown(turn))
                                    .then(() => setCopiedTurn(turn.id))
                                    .catch(() => setCopiedTurn(null));
                                }}
                              >
                                <Icon name={copiedTurn === turn.id ? 'check' : 'link'} size={14} />
                              </button>
                              <button
                                type="button"
                                className="ta"
                                aria-label="Unduh jawaban"
                                title="Unduh jawaban (.md)"
                                onClick={() => download(markdown(turn), turn.question)}
                              >
                                <Icon name="download" size={14} />
                              </button>
                            </>
                          )}
                          <span className="turn-stats">
                            {turn.helpful === false
                              ? 'Dicatat sebagai kebutuhan pengetahuan · '
                              : ''}
                            {copiedTurn === turn.id ? 'Tersalin · ' : ''}
                            dicari di {turn.scopeSize} versi
                            {turn.rejectedCount > 0
                              ? ` · ${turn.rejectedCount} kutipan disaring`
                              : ''}
                          </span>
                        </div>
                      </div>
                    </div>
                  </article>
                );
              })}
              {pending && (
                <div className="a-msg a-pending" aria-label="Sedang mencari">
                  <span className="a-avatar pulse" aria-hidden="true">
                    <Icon name="spark" size={15} />
                  </span>
                  <div className="typing">
                    <span className="dots">
                      <i />
                      <i />
                      <i />
                    </span>
                    Mencari di dokumen{generating ? ' dan menyusun jawaban' : ''}…
                    {generating ? ' Model berjalan lokal, biasanya 10–30 detik.' : ''}
                  </div>
                </div>
              )}
              {error && (
                <div className="callout c-warn" role="alert">
                  <Icon name="alert" size={18} />
                  <div>{error}</div>
                </div>
              )}
              <div ref={threadEnd} />
            </div>
          </div>
        </div>

        <div className="chat-dock">
          <form
            className="chat-box"
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
              rows={1}
              onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void ask(question);
                }
              }}
              placeholder={
                turns.length ? 'Tulis pertanyaan lanjutan…' : 'Tanyakan sesuatu tentang dokumen…'
              }
            />
            <div className="chat-box-row">
              <label htmlFor={sideId} className="chat-box-scope" title="Ubah cakupan jawaban">
                <Icon name="layers" size={13} />
                {scopeSummary}
              </label>
              <span className="chat-box-hint">Enter kirim · Shift+Enter baris baru</span>
              <button
                className="chat-send"
                type="submit"
                disabled={pending || !question.trim()}
                aria-label={pending ? 'Mencari…' : 'Kirim pertanyaan'}
                title={pending ? 'Mencari…' : 'Kirim (Enter)'}
              >
                <Icon name="up" size={16} />
              </button>
            </div>
          </form>
          <p className="chat-disclaimer">
            Disusun dari dokumen resmi yang boleh Anda baca — periksa sumbernya sebelum bertindak.
          </p>
        </div>
      </section>
    </div>
  );
}

/** One entry per cited document, in first-seen order, linking to its best citation. */
function groupCitations(citations: readonly AssistantCitation[]) {
  const docs: Array<{
    documentId: string;
    documentTitle: string;
    categoryName: string;
    href: string;
    count: number;
  }> = [];
  for (const c of citations) {
    const seen = docs.find((d) => d.documentId === c.documentId);
    if (seen) seen.count += 1;
    else
      docs.push({
        documentId: c.documentId,
        documentTitle: c.documentTitle,
        categoryName: c.categoryName,
        href: c.href,
        count: 1,
      });
  }
  return docs;
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
