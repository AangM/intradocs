import Link from 'next/link';
import { requireActor } from '@/lib/session';
import { approvalQueue } from '@intradocs/db/workflow';
import { PageHeading, Notice, Empty, documentHref } from '@/components/shared';
import { Icon } from '@/components/icon';
import { formatDate } from '@intradocs/core';
export default async function Approval() {
  const actor = await requireActor('documents.review');
  const rows = await approvalQueue(actor.id);
  return (
    <div className="pad">
      <PageHeading
        title="Antrean Persetujuan"
        subtitle="Versi yang ditugaskan kepada Anda, dengan scope dan klasifikasi diperiksa kembali."
      />
      <div className="approval-layout">
        <section className="card">
          <div className="card-h">
            <Icon name="clock" />
            <h2 className="h3">Menunggu review</h2>
            <span className="pill p-amber">{rows.length}</span>
          </div>
          {rows.length ? (
            rows.map((r) => (
              <article className="approval-card" key={r.versionId}>
                <span className="pill p-amber">
                  Tahap {r.stage}/{r.requiredSteps}
                </span>
                <h3>
                  <Link
                    className="document-title"
                    prefetch={false}
                    href={documentHref({ id: r.documentId, slug: r.slug, versionId: r.versionId })}
                  >
                    {r.title}
                  </Link>
                </h3>
                <p className="sub">
                  {r.ownerLabel} · {formatDate(r.submittedAt)}
                </p>
                <Link
                  className="btn btn-p"
                  prefetch={false}
                  href={documentHref({ id: r.documentId, slug: r.slug, versionId: r.versionId })}
                >
                  Tinjau & putuskan <Icon name="arrow-r" size={14} />
                </Link>
              </article>
            ))
          ) : (
            <Empty title="Antrean kosong">
              Tidak ada pengajuan yang ditugaskan dan bisa Anda akses.
            </Empty>
          )}
        </section>
        <section className="card">
          <div className="card-h">
            <Icon name="shield" />
            <h2 className="h3">Checklist reviewer</h2>
          </div>
          <div className="card-b">
            <ol className="review-timeline">
              <li>
                Bandingkan hasil Markdown, original, dan lampiran. Periksa angka, unit, dan urutan
                langkah.
              </li>
              <li>
                Tinjau temuan keamanan. False positive memerlukan justifikasi; private key harus
                dihapus melalui versi baru.
              </li>
              <li>Isi alasan minimal 10 karakter ketika meminta revisi atau menolak.</li>
              <li>
                Setujui hanya tahap Anda. Kritikal dan kategori berisiko memerlukan dua reviewer
                berbeda.
              </li>
            </ol>
            <Notice>
              Persetujuan final memasukkan versi ke antrean indeks. Dokumen baru terlihat sesudah
              publikasi atomik selesai. Worker gagal tidak berarti sukses publikasi.
            </Notice>
          </div>
        </section>
      </div>
    </div>
  );
}
