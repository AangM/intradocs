import Link from 'next/link';
import { requireActor } from '@/lib/session';
import { ownerFeedback } from '@intradocs/db/workflow';
import { formatDate } from '@intradocs/core';
import { PageHeading, Empty, documentHref } from '@/components/shared';
export default async function Feedback() {
  const a = await requireActor(),
    rows = await ownerFeedback(a.id);
  return (
    <div className="pad">
      <PageHeading
        title="Masukan Dokumen"
        subtitle="Apa kata pembaca tentang dokumen Anda."
      />
      {rows.length ? (
        <section className="card">
          <div className="card-h">
            <h2 className="h3">Masukan pembaca</h2>
          </div>
          <ul className="personal-list">
            {rows.map((f) => (
              <li key={f.id}>
                <div>
                  <p className="hint">
                    {formatDate(f.createdAt)} · {f.helpful ? 'Membantu' : 'Perlu perbaikan'}
                  </p>
                  <Link
                    href={documentHref({ id: f.documentId, slug: f.slug, versionId: f.versionId })}
                  >
                    {f.title}
                  </Link>
                  <p className="feedback-comment">{f.comment || 'Tanpa komentar.'}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <Empty title="Belum ada masukan">
          Penilaian dan komentar pembaca akan muncul setelah dokumen Anda dipublikasikan.
        </Empty>
      )}
    </div>
  );
}
