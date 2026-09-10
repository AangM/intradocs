import Link from 'next/link';
import { requireActor } from '@/lib/session';
import { listCategories, listDocuments } from '@intradocs/db/queries';
import { formatDate, formatNumber } from '@intradocs/core';
import { Icon } from '@/components/icon';
import { Footer, Empty, documentHref } from '@/components/shared';
import { mostRead } from '@intradocs/db/discovery';
export default async function HelpCenter() {
  const actor = await requireActor();
  const [categories, docs, popular] = await Promise.all([
    listCategories(actor.id),
    listDocuments(actor.id, {
      q: '',
      category: null,
      page: 1,
      status: 'published',
      sort: 'updated',
    }),
    mostRead(actor.id),
  ]);
  return (
    <>
      <section className="hero">
        <div className="hero-in">
          <span className="hero-badge">
            <Icon name="zap" size={14} />
            {formatNumber(docs.total)} dokumen contoh tersedia sesuai akses Anda
          </span>
          <h1>
            Ada yang bisa kami <em>bantu?</em>
          </h1>
          <p>
            Cari SOP, panduan aplikasi, dan kebijakan IT dalam satu knowledge base. Mulai dengan
            dokumen sintetis; AI Assistant akan hadir pada tahap berikutnya.
          </p>
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
          <div className="sugg">
            <div className="sugg-t">Mulai dari topik ini</div>
            {['VPN', 'Backup', 'Monitoring', 'Repository', 'Onboarding', 'SOP'].map((q) => (
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
              <div className="l">Dokumen aktif terlihat</div>
            </div>
            <div className="hs">
              <div className="n">{categories.length}</div>
              <div className="l">Kategori dalam scope</div>
            </div>
            <div className="hs">
              <div className="n">MD</div>
              <div className="l">Format canonical</div>
            </div>
            <div className="hs">
              <div className="n">Off</div>
              <div className="l">AI · tidak mengirim data</div>
            </div>
          </div>
        </div>
      </section>
      <section className="sec">
        <div className="sec-h">
          <div>
            <h2 className="t">
              <Icon name="grid" size={21} />
              Jelajahi berdasarkan kategori
            </h2>
            <p className="d">Knowledge dikelompokkan per domain agar mudah ditemukan tim</p>
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
                <span className="pill p-grey">Sesuai akses</span>
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
            <p className="d">
              Pilihan dari dokumen yang tersedia untuk akun Anda, bukan peringkat popularitas
            </p>
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
            <span className="pill ai-status">AI ASSISTANT · BELUM AKTIF</span>
            <h3 style={{ marginTop: 11 }}>Tanya dengan mudah. Tetap dekat dengan sumber.</h3>
            <p>
              Jawaban berbasis sumber, kutipan yang dapat dibuka, dan akses yang mengikuti akun Anda
              adalah target tahap M4. Belum ada model, biaya AI, atau pertanyaan yang dikirim dari
              build ini.
            </p>
            <Link className="btn-w" href="/ai-assistant">
              Lihat status AI <Icon name="arrow-r" size={14} />
            </Link>
          </div>
          <div className="ai-mini z">
            <div className="q">Bagaimana konfigurasi VPN?</div>
            <div className="a">
              AI belum aktif. Untuk saat ini, temukan panduan melalui pencarian dan baca sumbernya
              langsung.
            </div>
            <div className="src">
              <span>Tanpa jawaban simulasi</span>
              <span>Tanpa request cloud</span>
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
            <p className="d">Versi contoh published, diurutkan berdasarkan waktu pembuatan versi</p>
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
              <article className="notification-row" key={d.id}>
                <span className="rank">{i + 1}</span>
                <Link href={documentHref(d)} prefetch={false}>
                  {d.title}
                </Link>
                <span className="sub">{d.reads} baca</span>
              </article>
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
