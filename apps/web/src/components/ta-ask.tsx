'use client';
import { useState } from 'react';
import Link from 'next/link';
import { Icon } from './icon';

type Item = { id: string; name: string; kind: string; depth?: number };
type Answer = {
  type: 'impact' | 'dependencies' | 'element' | 'list' | 'suggest' | 'none';
  text: string;
  subject: Item | null;
  filter: string | null;
  items: Item[];
  semantic: boolean;
};
const EXAMPLES = [
  'Apa dampaknya jika esx-jkt-02 mati?',
  'Portal Tiket bergantung pada apa saja?',
  'Server mana yang sudah end of support?',
  'Berapa VM di production?',
];

/**
 * Questions about the model, answered from the data: every line of the answer is an
 * element with a link, so nothing here is a claim the page cannot show the source of.
 */
export function TaAsk() {
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [error, setError] = useState('');
  async function ask(text: string) {
    const q = text.trim();
    if (!q || busy) return;
    setQuestion(q);
    setBusy(true);
    setError('');
    try {
      const r = await fetch('/api/ta/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q }),
      });
      const body = await r.json().catch(() => null);
      if (!r.ok) throw new Error(body?.error ?? 'Tidak dapat menjawab.');
      setAnswer(body as Answer);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Tidak dapat menjawab.');
    } finally {
      setBusy(false);
    }
  }
  const grouped =
    answer && (answer.type === 'impact' || answer.type === 'dependencies')
      ? [1, 2, 3].map((d) => ({
          d,
          items: answer.items.filter((i) => (d === 3 ? (i.depth ?? 0) >= 3 : i.depth === d)),
        }))
      : [];
  return (
    <section className="card card-b ta-ask" aria-labelledby="ta-ask-title">
      <div className="ta-ask-h">
        <span className="ta-ask-ic">
          <Icon name="spark" size={16} />
        </span>
        <div>
          <h2 id="ta-ask-title" className="h3">
            Tanya arsitektur
          </h2>
          <p className="sub tiny">
            Dampak, dependensi, end of support, inventori — dijawab dari data model, setiap elemen
            bisa dibuka.
          </p>
        </div>
      </div>
      <form
        className="ta-ask-form"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(question);
        }}
      >
        <input
          className="inp"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Contoh: apa dampaknya jika srv-db-01 mati?"
          aria-label="Pertanyaan tentang arsitektur"
          maxLength={500}
        />
        <button className="btn btn-p" type="submit" disabled={busy || question.trim().length < 2}>
          {busy ? 'Menjawab…' : 'Tanya'}
        </button>
      </form>
      <div className="ta-examples">
        {EXAMPLES.map((x) => (
          <button
            key={x}
            type="button"
            className="chip"
            onClick={() => void ask(x)}
            disabled={busy}
          >
            {x}
          </button>
        ))}
      </div>
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
      {answer && (
        <div className="ta-answer" aria-live="polite">
          <p className="ta-answer-text">
            {answer.subject && (
              <Link href={`/arsitektur/${answer.subject.id}`} className="ta-subject">
                {answer.subject.name}
              </Link>
            )}{' '}
            {answer.text}
          </p>
          {grouped.length > 0 ? (
            grouped
              .filter((g) => g.items.length)
              .map((g) => (
                <div key={g.d} className="ta-answer-group">
                  <span className="sub tiny">
                    {g.d === 1 ? 'Langsung' : g.d === 2 ? 'Tingkat 2' : 'Tingkat 3+'}
                  </span>
                  <div className="ta-answer-items">
                    {g.items.map((i) => (
                      <Link key={i.id} href={`/arsitektur/${i.id}`} className="tag">
                        {i.name}
                      </Link>
                    ))}
                  </div>
                </div>
              ))
          ) : answer.items.length ? (
            <div className="ta-answer-items">
              {answer.items.map((i) => (
                <Link key={i.id} href={`/arsitektur/${i.id}`} className="tag">
                  {i.name}
                </Link>
              ))}
            </div>
          ) : null}
          {answer.semantic && (
            <p className="sub tiny">Dicari lewat indeks semantik WeKnora atas kartu elemen.</p>
          )}
        </div>
      )}
    </section>
  );
}
