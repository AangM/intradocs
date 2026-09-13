import Link from 'next/link';
import { requireActor } from '@/lib/session';
import { listCategories, listDocuments } from '@intradocs/db/queries';
import { formatDate, formatNumber, formatRelative } from '@intradocs/core';
import { Icon } from '@/components/icon';
import { Footer, Empty, documentHref } from '@/components/shared';
import { mostRead, popularSearches } from '@intradocs/db/discovery';
import { myRequiredReading } from '@intradocs/db/required-reading';
import { RequiredReadingList } from '@/components/required-reading-list';
import { aiStatus } from '@/lib/rag';
export default async function HelpCenter() {
  const actor = await requireActor();
  const [categories, docs, popular, measuredTopics, required] = await Promise.all([
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
  ]);
  const pendingReading = required.filter((r) => !r.acknowledgedAt).length;
  const ai = aiStatus();
  const aiOn = ai.retrieval !== 'off';
  const aiGenerates = aiOn && ai.generation !== 'off';
  return (
    <>
      <section className="hero">
        <div className="hero-in">
          <span className="hero-badge">
            <Icon name="zap" size={14} />
            {formatNumber(docs.total)} dokumen resmi yang boleh Anda baca
          </span>
          <h1>
            Ada yang bisa kami <em>bantu?</em>
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
          {aiOn && (
            <p className="hero-alt">
              Hanya ingin mencari kata di dokumen?{' '}
              <Link href="/search" prefetch={false}>
                Buka pencarian dokumen
              </Link>
            </p>
          )}
          <div className="sugg">
            {/* Measured topics once enough distinct people have searched them and found
                something; the curated list stands in while the log is too small to be
                anonymous, so a quiet installation never surfaces one person's search. */}
            <div className="sugg-t">
              {measuredTopics.length ? 'Paling sering dicari' : 'Mulai dari topik ini'}
            </div>
            {(measuredTopics.length
              ? measuredTopics
              : ['VPN', 'Backup', 'Monitoring', 'Repository', 'Onboarding', 'SOP']
            ).map((q) => (
              <Link
                className="chip"
                key={q}
                href={`/search?q=${encodeURIComponent(q)}`}
                prefetch={false}
              >
                <Icon name="search" size={13} />
                {q}
              </Link>
            ))}
          </div>
          <div className="hero-stats">
            <div className="hs">
              <div className="n">{formatNumber(docs.total)}</div>
              <div className="l">Dokumen resmi</div>
            </div>
            <div className="hs">
              <div className="n">{categories.length}</div>
              <div className="l">Kategori</div>
            </div>
            <div className="hs">
              <div className="n">
                {docs.items[0] ? formatRelative(docs.items[0].updatedAt) : '—'}
              </div>
              <div className="l">Pembaruan terakhir</div>
            </div>
            <div className="hs">
              <div className="n">{aiOn ? 'Aktif' : 'Nonaktif'}</div>
              <div className="l">
                {aiOn ? 'AI Assistant · berjalan di mesin ini' : 'AI Assistant'}
              </div>
            </div>
          </div>
        </div>
      </section>
      {required.length > 0 && (
        <section className="sec">
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
      <section className="sec">
        <div className="sec-h">
          <div>
            <h2 className="t">
              <Icon name="grid" size={21} />
              Jelajahi berdasarkan kategori
            </h2>
            <p className="d">Telusuri dokumen per bidang</p>
          </div>
          <Link href="/katalog">
            Lihat semua dokumen <Icon name="arrow-r" size={14} />
          </Link>
        </div>
        <div className="grid g3">
          {categories.map((c) => (
            <Link
              key={c.id}
              className={`cat tone-${c.color}`}
              href={`/katalog?category=${c.id}`}
              prefetch={false}
            >
              <span className="ic">
                <Icon name={c.icon} size={22} />
              </span>
              <h3 className="t">{c.name}</h3>
              <p className="d">{c.description}</p>
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
      <section className="sec no-top-pad">
        <div className="sec-h">
          <div>
            <h2 className="t">
              <Icon name="book" size={21} />
              Mulai membaca
            </h2>
            <p className="d">Dokumen yang bisa Anda buka sekarang</p>
          </div>
          <Link href="/katalog">
            Buka katalog <Icon name="arrow-r" size={14} />
          </Link>
        </div>
        {docs.items.length ? (
          <div className="grid g2">
            {docs.items.slice(0, 4).map((d, i) => (
              <Link key={d.id} className="mostread" href={documentHref(d)} prefetch={false}>
                <span className="rank">{i + 1}</span>
                <div>
                  <h3 className="t">{d.title}</h3>
                  <div className="m">
                    <span className="tag">{d.categoryName}</span>
                    <span>v{d.versionLabel}</span>
                    <span>· {formatDate(d.updatedAt)}</span>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        ) : (
          <Empty>Belum ada dokumen published pada cakupan Anda.</Empty>
        )}
      </section>
      <section className="sec no-top-pad">
        <div className="ai-banner">
          <div className="z" style={{ flex: 1 }}>
            <span className="pill ai-status">
              {aiOn
                ? aiGenerates
                  ? ai.generationLocation === 'external'
                    ? 'AI ASSISTANT · AKTIF · PROVIDER EKSTERNAL'
                    : 'AI ASSISTANT · AKTIF · LOKAL'
                  : 'AI ASSISTANT · AKTIF · HANYA SUMBER'
                : 'AI ASSISTANT · BELUM AKTIF'}
            </span>
            <h3 style={{ marginTop: 11 }}>Tanya apa saja — jawabannya dari dokumen resmi.</h3>
            <p>
              {aiOn
                ? aiGenerates
                  ? 'Setiap jawaban menyebut dokumen dan bagian yang menjadi sumbernya, dan bisa dibuka satu klik. Kalau tidak ada dokumennya, asisten bilang tidak tahu.'
                  : 'Asisten menunjukkan bagian dokumen yang relevan dan boleh Anda baca. Kalau tidak ada, ia bilang tidak tahu.'
                : 'AI belum diaktifkan pada instalasi ini. Gunakan pencarian untuk menemukan dokumen.'}
            </p>
            <Link className="btn-w" href="/ai-assistant">
              {aiOn ? 'Buka AI Assistant' : 'Lihat status AI'} <Icon name="arrow-r" size={14} />
            </Link>
          </div>
          <div className="ai-mini z">
            <div className="q">Apakah MFA wajib untuk VPN lab?</div>
            <div className="a">
              {aiOn
                ? 'Ya. Profil VPN laboratorium mensyaratkan akun uji dan MFA saat masuk — lihat Konfigurasi VPN, bagian “Langkah konfigurasi”.'
                : 'AI belum aktif. Temukan panduan lewat pencarian dan baca sumbernya langsung.'}
            </div>
            <div className="src">
              <span>Konfigurasi VPN · v1.0</span>
              <span>
                {aiOn && ai.generationLocation === 'external'
                  ? 'Provider eksternal'
                  : 'Berjalan di mesin ini'}
              </span>
            </div>
          </div>
        </div>
      </section>
      <section className="sec no-top-pad">
        <div className="sec-h">
          <div>
            <h2 className="t">
              <Icon name="check-c" size={21} />
              Dokumen terbaru
            </h2>
            <p className="d">Baru disetujui dan diterbitkan</p>
          </div>
        </div>
        <div className="card">
          {docs.items.slice(0, 3).map((d) => (
            <div key={d.id} className="recent-row">
              <span className="ft ft-md">MD</span>
              <div className="col">
                <Link className="document-title" href={documentHref(d)} prefetch={false}>
                  {d.title}
                </Link>
                <span className="sub">
                  {d.categoryName} · oleh {d.ownerLabel}
                </span>
              </div>
              <span className="pill p-green">Published</span>
              <span className="date-cell">{formatDate(d.updatedAt)}</span>
            </div>
          ))}
        </div>
      </section>
      <section className="sec">
        <div className="sec-h">
          <h2 className="h2">Paling dibaca</h2>
          <span className="sub">30 hari · hanya dokumen aktif berizin</span>
        </div>
        <div className="card">
          {popular.length ? (
            popular.map((d, i) => (
              <Link
                className="mostread mostread-row"
                key={d.id}
                href={documentHref(d)}
                prefetch={false}
              >
                <span className="rank">{i + 1}</span>
                <div>
                  <h3 className="t">{d.title}</h3>
                  <div className="m">{d.reads} kali dibaca dalam 30 hari</div>
                </div>
              </Link>
            ))
          ) : (
            <Empty title="Belum ada aktivitas baca">
              Publikasi terbaru tetap tersedia di atas.
            </Empty>
          )}
        </div>
      </section>
      <Footer />
    </>
  );
}
