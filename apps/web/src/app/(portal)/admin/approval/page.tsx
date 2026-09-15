import Link from 'next/link';
import { requireActor } from '@/lib/session';
import { getStorage } from '@/lib/storage';
import { approvalQueue, reviewInfo } from '@intradocs/db/workflow';
import { readDocument } from '@intradocs/db/queries';
import { readSourceMetadata } from '@intradocs/db/uploads';
import { withActor } from '@intradocs/db';
import { parseUuid } from '@intradocs/core/validation';
import { formatDate, formatRelative, initials } from '@intradocs/core';
import { Empty, Notice, documentHref } from '@/components/shared';
import { Icon } from '@/components/icon';
import { DocumentBody } from '@/components/document-body';
import { ApprovalDetail } from '@/components/approval-detail';

/**
 * Reviewer's queue as master-detail (mockup S06): the submissions assigned to this
 * actor on the left, the selected one on the right. Selection is a query parameter, so
 * a link to one submission survives a reload and the back button. The reader page still
 * carries the same panel for anyone arriving from a notification.
 */
export default async function Approval({
  searchParams,
}: {
  searchParams: Promise<{ v?: string }>;
}) {
  const actor = await requireActor('documents.review');
  const rows = await approvalQueue(actor.id);
  let selectedId: string | null = null;
  try {
    const value = (await searchParams).v;
    if (value) selectedId = parseUuid(value);
  } catch {
    selectedId = null;
  }
  const selected = rows.find((r) => r.versionId === selectedId) ?? rows[0] ?? null;

  let detail: React.ReactNode = null;
  if (selected) {
    const doc = await readDocument(actor.id, selected.documentId, selected.versionId);
    const info = doc ? await reviewInfo(actor.id, selected.versionId) : null;
    if (doc && info) {
      const [markdown, source, attachments] = await Promise.all([
        getStorage()
          .read(doc.markdownKey, doc.markdownHash)
          .then((b) => Buffer.from(b).toString('utf8')),
        readSourceMetadata(actor.id, selected.versionId),
        withActor(actor.id, async ({ client }) =>
          (
            await client.query<{
              ordinal: number;
              name: string;
              source_format: string;
              original_bytes: number;
            }>(
              'SELECT ordinal,name,source_format,original_bytes FROM app.version_attachments WHERE version_id=$1 ORDER BY ordinal',
              [selected.versionId],
            )
          ).rows.map((a) => ({
            ordinal: a.ordinal,
            name: a.name,
            format: a.source_format,
            bytes: a.original_bytes,
          })),
        ),
      ]);
      detail = (
        <ApprovalDetail
          key={selected.versionId + info.state + info.findings.filter((f) => f.resolved).length}
          item={selected}
          actorId={actor.id}
          info={info}
          source={source}
          attachments={attachments}
          href={documentHref({ id: doc.id, slug: doc.slug, versionId: doc.versionId })}
          preview={<DocumentBody markdown={markdown} title={doc.title} />}
        />
      );
    }
  }

  return (
    <div className="appr-page">
      <aside className="appr-list" aria-label="Antrean pengajuan" tabIndex={0}>
        <div className="appr-list-head">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h1 className="h3">Antrean Persetujuan</h1>
            <span className={`pill ${rows.length ? 'p-amber' : 'p-grey'}`}>
              {rows.length} menunggu
            </span>
          </div>
          <p className="sub tiny">Ditugaskan kepada Anda; scope dan klasifikasi diperiksa ulang.</p>
        </div>
        {rows.length ? (
          rows.map((r) => (
            <Link
              key={r.versionId}
              href={`/admin/approval?v=${r.versionId}`}
              prefetch={false}
              className={`appr-i ${selected?.versionId === r.versionId ? 'on' : ''}`}
              aria-current={selected?.versionId === r.versionId ? 'page' : undefined}
            >
              <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
                <span
                  className={`pill ${r.labels.includes('Kritikal') || r.classification !== 'internal' ? 'p-red' : 'p-grey'}`}
                >
                  {r.labels.includes('Kritikal')
                    ? 'Kritikal'
                    : r.classification === 'internal'
                      ? 'Normal'
                      : r.classification === 'public'
                        ? 'Publik'
                        : 'Terbatas'}
                </span>
                <time
                  className="sub tiny"
                  dateTime={r.submittedAt}
                  title={formatDate(r.submittedAt)}
                >
                  {formatRelative(r.submittedAt)}
                </time>
              </div>
              <div className="t">{r.title}</div>
              <div className="m">
                <span className="avatar avatar-xs">{initials(r.ownerLabel)}</span>
                {r.ownerLabel}
                <span>·</span>
                <span className="tag tag-xs">
                  {r.format.toUpperCase()}
                  {r.attachments ? ` + ${r.attachments} lampiran` : ''}
                </span>
              </div>
              <div className="m" style={{ marginTop: 6 }}>
                <span className="pill p-amber pill-xs">
                  Tahap {r.stage} dari {r.requiredSteps}
                </span>
                {r.openFindings > 0 && (
                  <span className="pill p-violet pill-xs">
                    <Icon name="shield" size={10} /> Pra-cek: {r.openFindings} temuan
                  </span>
                )}
              </div>
            </Link>
          ))
        ) : (
          <Empty title="Antrean kosong">
            Tidak ada pengajuan yang ditugaskan dan bisa Anda akses.
          </Empty>
        )}
      </aside>
      <section className="appr-detail-wrap" aria-label="Detail pengajuan">
        {detail ?? (
          <div className="pad appr-idle">
            {/* Nothing selected (or nothing to review): the four rules of a review as
                four tiles, and the step a decision sets in motion -- glanceable, not a
                paragraph to read. */}
            <div className="appr-idle-head">
              <span className="nt-ic nt-review" aria-hidden="true">
                <Icon name="shield" size={16} />
              </span>
              <div>
                <h2 className="h3">
                  {rows.length ? 'Pilih pengajuan di kiri' : 'Tidak ada yang menunggu Anda'}
                </h2>
                <p className="sub">Empat hal yang diperiksa reviewer sebelum memutuskan.</p>
              </div>
            </div>
            <div className="appr-rules">
              {[
                {
                  icon: 'file',
                  t: 'Bandingkan hasil & asli',
                  d: 'Markdown, berkas original, lampiran — angka, unit, urutan langkah.',
                },
                {
                  icon: 'lock',
                  t: 'Tinjau temuan keamanan',
                  d: 'False positive butuh justifikasi; private key dihapus lewat versi baru.',
                },
                {
                  icon: 'msg',
                  t: 'Beri alasan',
                  d: 'Minimal 10 karakter saat meminta revisi atau menolak.',
                },
                {
                  icon: 'users',
                  t: 'Setujui tahap Anda saja',
                  d: 'Kritikal & kategori berisiko: dua reviewer berbeda.',
                },
              ].map((r, i) => (
                <div className="appr-rule" key={r.t}>
                  <span className="appr-rule-n">{i + 1}</span>
                  <span className="appr-rule-ic">
                    <Icon name={r.icon} size={15} />
                  </span>
                  <div>
                    <div className="appr-rule-t">{r.t}</div>
                    <div className="appr-rule-d">{r.d}</div>
                  </div>
                </div>
              ))}
            </div>
            <Notice>
              Persetujuan final memasukkan versi ke antrean indeks; dokumen tampil setelah publikasi
              selesai.
            </Notice>
          </div>
        )}
      </section>
    </div>
  );
}
