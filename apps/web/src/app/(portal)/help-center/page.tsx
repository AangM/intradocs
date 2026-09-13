import Link from 'next/link';
import { requireActor } from '@/lib/session';
import { listCategories, listDocuments } from '@intradocs/db/queries';
import { hasCapability, formatDate, formatNumber, formatRelative } from '@intradocs/core';
import { Icon } from '@/components/icon';
import { Footer, Empty, documentHref } from '@/components/shared';
import { mostRead, popularSearches } from '@intradocs/db/discovery';
import { myRequiredReading } from '@intradocs/db/required-reading';
import { sidebarCounts } from '@intradocs/db/workflow';
import { RequiredReadingList } from '@/components/required-reading-list';
import { aiStatus } from '@/lib/rag';

/**
 * Topic shortcuts while the search log is too small to be anonymous. Each one is a
 * real question the fixture corpus can answer, so a click lands on an answer, not on
 * a one-word query; the label is what the chip shows.
 */
const STARTER_TOPICS: ReadonlyArray<{ label: string; question: string }> = [
  { label: 'VPN', question: 'Bagaimana cara konfigurasi VPN pada perangkat uji?' },
  { label: 'Backup', question: 'Kapan sebuah backup boleh dianggap berhasil?' },
  { label: 'Monitoring', question: 'Apa prasyarat memasang agent monitoring?' },
  { label: 'Repository', question: 'Apa standar penamaan repository dan branch?' },
  { label: 'Reset password', question: 'Bagaimana prosedur reset password akun lab?' },
  { label: 'Rotasi kunci API', question: 'Kapan kunci API laboratorium harus dirotasi?' },
];

export default async function HelpCenter() {
  const actor = await requireActor();
  const [categories, docs, popular, measuredTopics, required, counts] = await Promise.all([
    listCategories(actor.id),
    listDocuments(actor.id, {
      q: '',
      category: null,
      page: 1,
      status: 'published',
      sort: 'updated',
    }),
    mostRead(actor.id),
    popularSearches(actor.id),
    myRequiredReading(actor.id),
    sidebarCounts(actor.id),
  ]);
  const pendingReading = required.filter((r) => !r.acknowledgedAt).length;
  const ai = aiStatus();
  const aiOn = ai.retrieval !== 'off';
  const firstName = actor.name.trim().split(/\s+/)[0] ?? '';
  // A topic chip asks the assistant when there is one, else it searches. Measured
  // topics are search terms; wrapped as a question they still retrieve on the term.
  const topics = measuredTopics.length
    ? measuredTopics.map((t) => ({
        label: t,
        question: `Apa yang dijelaskan dokumen tentang ${t}?`,
      }))
    : STARTER_TOPICS;
  const topicHref = (t: { label: string; question: string }) =>
    aiOn
      ? `/ai-assistant?ask=1&q=${encodeURIComponent(t.question)}`
      : `/search?q=${encodeURIComponent(t.label)}`;
  // Things waiting on this person, shown only when there are any.
  const attention: Array<{ href: string; icon: string; label: string; n: number }> = [
    {
      href: '/admin/approval',
      icon: 'check-c',
      label: 'pengajuan menunggu review Anda',
      n: counts.approvals,
    },
    {
      href: '/notifikasi',
      icon: 'bell',
      label: 'notifikasi belum dibaca',
      n: counts.notifications,
    },
    {
      href: '/katalog?status=mine',
      icon: 'edit',
      label: 'draft Anda belum diajukan',
      n: counts.drafts,
    },
  ].filter((a) => a.n > 0);
  const latest = docs.items.slice(0, 5);
  const colorOf = new Map(categories.map((c) => [c.id, c.color]));
  return (
    <>
      <section className="hero home-hero">
        <div className="hero-in">
          <span className="hero-badge">
            <Icon name="zap" size={14} />
            {formatNumber(docs.total)} dokumen resmi · {categories.length} kategori
            {docs.items[0] ? ` · diperbarui ${formatRelative(docs.items[0].updatedAt)}` : ''}
          </span>
          <h1>
            {firstName ? `Halo, ${firstName}. ` : ''}Ada yang bisa kami <em>bantu?</em>
          </h1>
          <p>
            {aiOn
              ? 'Tanyakan langsung — jawabannya disusun dari dokumen resmi dan selalu menyebut sumbernya.'
              : 'Cari SOP, panduan aplikasi, dan kebijakan IT dalam satu tempat.'}
          </p>
          {aiOn ? (
            <form className="bigsearch" action="/ai-assistant" role="search">
              <input type="hidden" name="ask" value="1" />
              <Icon name="spark" size={22} />
              <label htmlFor="hero-q" className="sr-only">
                Apa yang ingin Anda tanyakan?
              </label>
              <input
                id="hero-q"
                name="q"
                placeholder="Contoh: Apakah MFA wajib untuk VPN lab?"
                maxLength={2000}
                autoComplete="off"
              />
              <button className="go" type="submit">
                <Icon name="spark" size={15} />
                Tanya AI
              </button>
            </form>
          ) : (
            <form className="bigsearch" action="/search" role="search">
              <Icon name="search" size={22} />
              <label htmlFor="hero-q" className="sr-only">
                Apa yang ingin Anda cari?
              </label>
              <input id="hero-q" name="q" placeholder='Contoh: "konfigurasi VPN"' maxLength={200} />
              <button className="go" type="submit">
                <Icon name="search" size={15} />
                Cari dokumen
              </button>
            </form>
          )}
          <div className="sugg">
            {/* Measured topics once enough distinct people have searched them and found
                something; the curated list stands in while the log is too small to be
                anonymous, so a quiet installation never surfaces one person's search. */}
            <div className="sugg-t">
              {measuredTopics.length ? 'Paling sering ditanyakan' : 'Coba tanyakan'}
            </div>
            {topics.map((t) => (
              <Link
                className="chip"
                key={t.label}
                href={topicHref(t)}
                prefetch={false}
                title={aiOn ? t.question : `Cari "${t.label}"`}
              >
                <Icon name={aiOn ? 'spark' : 'search'} size={13} />
                {t.label}
              </Link>
            ))}
          </div>
          {aiOn && (
            <p className="hero-alt">
              Hanya ingin mencari kata di dokumen?{' '}
              <Link href="/search" prefetch={false}>
                Buka pencarian dokumen
              </Link>
            </p>
          )}
        </div>
      </section>

      {attention.length > 0 && (
        <section className="sec home-sec">
          <div className="attn" role="region" aria-label="Menunggu Anda">
            <span className="attn-t">
              <Icon name="act" size={15} />
              Menunggu Anda
            </span>
            {attention.map((a) => (
              <Link key={a.href} href={a.href} className="attn-i" prefetch={false}>
                <Icon name={a.icon} size={14} />
                <strong>{a.n}</strong> {a.label}
                <Icon name="arrow-r" size={12} className="attn-go" />
              </Link>
            ))}
          </div>
        </section>
      )}

      {required.length > 0 && (
        <section className="sec home-sec">
          <div className="sec-h">
            <div>
              <h2 className="t">
                <Icon name="check-c" size={21} />
                Bacaan wajib
                {pendingReading > 0 ? ` (${pendingReading} belum dikonfirmasi)` : ''}
              </h2>
              <p className="d">Dokumen yang perlu Anda baca dan konfirmasi</p>
            </div>
          </div>
          <div className="card">
            <RequiredReadingList
              items={required.map((r) => ({
                id: r.id,
                href: documentHref({ id: r.documentId, slug: r.documentSlug }),
                documentTitle: r.documentTitle,
                categoryName: r.categoryName,
                note: r.note,
                overdue: r.overdue,
                dueLabel: r.dueAt ? formatDate(r.dueAt) : null,
                acknowledgedLabel: r.acknowledgedAt ? formatDate(r.acknowledgedAt) : null,
                versionId: r.versionId,
              }))}
            />
          </div>
        </section>
      )}

      <section className="sec home-sec">
        <div className="sec-h">
          <div>
            <h2 className="t">
              <Icon name="grid" size={21} />
              Jelajahi per kategori
            </h2>
          </div>
          <Link href="/katalog" prefetch={false}>
            Semua dokumen <Icon name="arrow-r" size={14} />
          </Link>
        </div>
        <div className="grid g3 home-cats">
          {categories.map((c) => (
            <Link
              key={c.id}
              className={`cat tone-${c.color}`}
              href={`/katalog?category=${c.id}`}
              prefetch={false}
            >
              <span className="ic">
                <Icon name={c.icon} size={20} />
              </span>
              <div className="cat-body">
                <h3 className="t">{c.name}</h3>
                <p className="d">{c.description}</p>
              </div>
              <div className="m">
                <span>{formatNumber(c.documentCount)} dokumen</span>
                <span className="cat-go">
                  Buka <Icon name="arrow-r" size={13} />
                </span>
              </div>
            </Link>
          ))}
        </div>
      </section>

      <section className="sec home-sec">
        <div className="home-cols">
          <div className="home-col">
            <div className="sec-h">
              <div>
                <h2 className="t">
                  <Icon name="book" size={21} />
                  Baru diterbitkan
                </h2>
              </div>
              <Link href="/katalog?sort=updated" prefetch={false}>
                Katalog <Icon name="arrow-r" size={14} />
              </Link>
            </div>
            <div className="card home-list">
              {latest.length ? (
                latest.map((d) => (
                  <Link key={d.id} className="home-row" href={documentHref(d)} prefetch={false}>
                    <span className="ft ft-md">MD</span>
                    <span className="home-row-b">
                      <span className="home-row-t">{d.title}</span>
                      <span className="home-row-m">
                        <span
                          className={`category-dot tone-${colorOf.get(d.categoryId) ?? 'blue'}`}
                        />
                        {d.categoryName} · v{d.versionLabel} · {formatRelative(d.updatedAt)}
                      </span>
                    </span>
                    <Icon name="chev-r" size={15} className="home-row-go" />
                  </Link>
                ))
              ) : (
                <Empty>Belum ada dokumen terbit pada cakupan Anda.</Empty>
              )}
            </div>
          </div>
          <div className="home-col">
            <div className="sec-h">
              <div>
                <h2 className="t">
                  <Icon name="eye" size={21} />
                  Paling dibaca
                </h2>
              </div>
              <span className="sub tiny">30 hari terakhir</span>
            </div>
            <div className="card home-list">
              {popular.length ? (
                popular.slice(0, 5).map((d, i) => (
                  <Link key={d.id} className="home-row" href={documentHref(d)} prefetch={false}>
                    <span className="rank">{i + 1}</span>
                    <span className="home-row-b">
                      <span className="home-row-t">{d.title}</span>
                      <span className="home-row-m">{d.reads} kali dibaca</span>
                    </span>
                    <Icon name="chev-r" size={15} className="home-row-go" />
                  </Link>
                ))
              ) : (
                <Empty title="Belum ada yang dibaca bersama">
                  Angka muncul setelah beberapa orang membaca dokumen yang sama.
                </Empty>
              )}
            </div>
            {hasCapability(actor, 'documents.upload') && (
              <Link href="/unggah" className="home-cta" prefetch={false}>
                <span className="home-cta-ic">
                  <Icon name="upload" size={18} />
                </span>
                <span>
                  <strong>Punya dokumen baru?</strong>
                  <span className="sub tiny">Unggah, ajukan review, terbit setelah disetujui.</span>
                </span>
                <Icon name="arrow-r" size={14} className="home-row-go" />
              </Link>
            )}
          </div>
        </div>
      </section>
      <Footer />
    </>
  );
}
