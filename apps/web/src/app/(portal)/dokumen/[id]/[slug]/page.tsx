import { relatedDocuments } from '@intradocs/db/discovery';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { requireActor } from '@/lib/session';
import { getStorage } from '@/lib/storage';
import { readDocument } from '@intradocs/db/queries';
import { readSourceMetadata } from '@intradocs/db/uploads';
import { withActor } from '@intradocs/db';
import { parseUuid } from '@intradocs/core/validation';
import { formatDate, initials } from '@intradocs/core';
import { getOutline } from '@/lib/markdown';
import { DocumentBody } from '@/components/document-body';
import { ClassificationBadge, Notice, StatusBadge, documentHref } from '@/components/shared';
import { Icon } from '@/components/icon';
import { DocumentAccess } from '@/components/document-access';
import { documentAccessCandidates } from '@intradocs/db/workflow';
import { AttachmentsList } from '@/components/attachments-list';
import { WorkflowPanel } from '@/components/workflow-panel';
import { ReaderFeedback } from '@/components/reader-feedback';
import { reviewInfo, versionSummaries, readerPreferences } from '@intradocs/db/workflow';
import { findSensitiveContent } from '@intradocs/core/workflow';
export default async function Reader({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; slug: string }>;
  searchParams: Promise<{ version?: string }>;
}) {
  const actor = await requireActor();
  const route = await params;
  let id: string;
  try {
    id = parseUuid(route.id);
  } catch {
    notFound();
  }
  let version: string | undefined;
  try {
    const value = (await searchParams).version;
    if (value) version = parseUuid(value);
  } catch {
    notFound();
  }
  const doc = await readDocument(actor.id, id, version);
  if (!doc) notFound();
  if (route.slug !== doc.slug) redirect(documentHref(doc));
  const markdown = Buffer.from(await getStorage().read(doc.markdownKey, doc.markdownHash)).toString(
    'utf8',
  );
  const stillAllowed = await withActor(
    actor.id,
    async ({ client }) =>
      (
        await client.query<{ ok: boolean }>('SELECT app.can_read_version($1) AS ok', [
          doc.versionId,
        ])
      ).rows[0]?.ok === true,
  );
  if (!stillAllowed) notFound();
  const [source, info, versions, preferences, related] = await Promise.all([
    readSourceMetadata(actor.id, doc.versionId),
    reviewInfo(actor.id, doc.versionId),
    versionSummaries(actor.id, id),
    readerPreferences(actor.id, id, doc.versionId),
    relatedDocuments(actor.id, id, doc.categoryId),
  ]);
  const access =
    actor.id === doc.ownerId && ['restricted', 'confidential'].includes(doc.classification)
      ? await documentAccessCandidates(actor.id, id)
      : null;
  const toc = getOutline(markdown);
  const expired = doc.expired;
  if (
    !(await withActor(
      actor.id,
      async ({ client }) =>
        (
          await client.query<{ ok: boolean }>('SELECT app.can_read_version($1) AS ok', [
            doc.versionId,
          ])
        ).rows[0]?.ok,
    ))
  )
    notFound();
  return (
    <div className="reader-page">
      <aside className="docnav" aria-label="Navigasi dokumen">
        <Link className="back-link" href="/katalog">
          <Icon name="chev-r" size={12} style={{ transform: 'rotate(180deg)' }} />
          Kembali ke katalog
        </Link>
        <div className="docnav-title">
          <div className="row">
            <span className={`ft ft-${doc.format.toLowerCase()}`}>{doc.format}</span>
            <span>{doc.title}</span>
          </div>
          <p className="sub">
            {doc.categoryName} · v{doc.versionLabel}
          </p>
        </div>
        <div className="dn-sec">Isi dokumen</div>
        {toc.map((t) => (
          <a key={t.id} className={`dn-i ${t.level === 3 ? 'sub' : ''}`} href={`#${t.id}`}>
            {t.label}
          </a>
        ))}
        <div className="local-note">
          Sumber: {source ? source.name : 'Markdown seed'}
          <br />
          <span>File dan checksum versi disimpan immutable.</span>
        </div>
      </aside>
      <div className="doc-main">
        <div className="doc-columns">
          <article className="doc-wrap">
            <nav className="crumbs" aria-label="Breadcrumb">
              <Link href={`/katalog?category=${doc.categoryId}`}>{doc.categoryName}</Link>
              <Icon name="chev-r" size={12} />
              <span>v{doc.versionLabel}</span>
            </nav>
            <h1>{doc.title}</h1>
            <div className="doc-meta">
              <div className="row">
                <span className="avatar">{initials(doc.ownerLabel)}</span>
                <span>
                  <strong>{doc.ownerLabel}</strong>
                  <span className="document-owner" style={{ display: 'block' }}>
                    Pemilik dokumen
                  </span>
                </span>
              </div>
              <span className="pill p-grey">v{doc.versionLabel}</span>
              <StatusBadge value={doc.status} />
              <ClassificationBadge value={doc.classification} />
              {doc.approvedBy && (
                <span className="pill p-green">
                  <Icon name="check-c" size={13} />
                  {source ? 'Disetujui' : 'Approval fixture'}: {doc.approvedBy}
                </span>
              )}
            </div>
            <div className="reader-actions">
              <a className="btn btn-sm" href={`/api/files/${doc.versionId}/markdown`}>
                <Icon name="download" size={15} />
                Unduh Markdown
              </a>
              <Link className="btn btn-sm" href="/ai-assistant">
                <Icon name="spark" size={15} />
                Status AI Assistant
              </Link>
              {doc.labels.map((t) => (
                <span className="tag" key={t}>
                  {t}
                </span>
              ))}
            </div>
            {doc.status === 'withdrawn' ? (
              <Notice kind="warn">
                <strong>Publikasi dicabut.</strong> Akses histori ini hanya untuk pemilik atau
                reviewer yang masih berwenang; bukan referensi yang berlaku.
              </Notice>
            ) : expired ? (
              <Notice kind="warn">
                <strong>Versi kedaluwarsa.</strong> Tidak ditampilkan pada pencarian published
                aktif. Bukan rujukan operasional.
              </Notice>
            ) : doc.status !== 'published' ? (
              <Notice kind="warn">
                <strong>Belum dipublikasikan.</strong> Hanya pemilik atau reviewer yang ditugaskan
                dan memiliki scope yang dapat membukanya.
              </Notice>
            ) : (
              <Notice>
                Dokumen sintetis untuk menguji reader dan hak akses.{' '}
                {doc.reviewAt && (
                  <>
                    Tanggal review contoh: <strong>{formatDate(doc.reviewAt)}</strong>. Pengingat
                    dalam aplikasi dimulai H−14.
                  </>
                )}
              </Notice>
            )}
            <details className="reader-outline-mobile">
              <summary>Di halaman ini</summary>
              {toc.map((t) => (
                <a key={t.id} href={`#${t.id}`}>
                  {t.label}
                </a>
              ))}
            </details>
            {source && (
              <details className="source-evidence">
                <summary>Asal berkas & integritas</summary>
                <p>
                  {source.name} · {source.format} · {(source.bytes / 1024).toFixed(1)} KiB
                </p>
                <p>
                  Pemindai: ClamAV {source.scannerVersion} · {formatDate(source.scannedAt)}. Bukti
                  scan bukan approval atau jaminan konten bebas risiko.
                </p>
                <p>
                  SHA-256 original: <code>{source.hash}</code>
                </p>
                <div className="row">
                  <a className="btn btn-sm" href={`/api/files/${doc.versionId}/original`}>
                    Unduh original
                  </a>
                  <a className="btn btn-sm" href={`/api/files/${doc.versionId}/provenance`}>
                    Unduh provenance
                  </a>
                </div>
              </details>
            )}
            <AttachmentsList actorId={actor.id} versionId={doc.versionId} />
            {access && <DocumentAccess documentId={id} candidates={access} />}
            <DocumentBody markdown={markdown} title={doc.title} />

            <section className="related-documents">
              <h2 className="h3">Dokumen terkait</h2>
              <p className="hint">Publikasi aktif dalam kategori yang sama, sesuai akses Anda.</p>
              {related.length ? (
                <ul>
                  {related.map((d) => (
                    <li key={d.id}>
                      <Link href={documentHref(d)}>{d.title}</Link>
                      <span className="pill p-grey">{d.format}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="sub">Belum ada dokumen terkait yang dapat ditampilkan.</p>
              )}
            </section>
            {doc.status === 'published' && !expired && (
              <ReaderFeedback
                documentId={id}
                versionId={doc.versionId}
                initialFavorite={preferences.favorite}
                initialFeedback={preferences.feedback}
              />
            )}
            {info && (
              <WorkflowPanel
                key={doc.versionId + info.state}
                documentId={id}
                versionId={doc.versionId}
                actorId={actor.id}
                owner={actor.id === doc.ownerId}
                latest={versions[0]?.id === doc.versionId}
                status={doc.status}
                info={info}
                versions={versions}
                preflight={source ? findSensitiveContent(markdown) : []}
                slug={doc.slug}
              />
            )}
          </article>
          <aside className="toc" aria-label="Daftar isi">
            <div className="toc-t">Di halaman ini</div>
            {toc.map((t) => (
              <a className={t.level === 3 ? 'i2' : ''} key={t.id} href={`#${t.id}`}>
                {t.label}
              </a>
            ))}
            <div className="versions-box">
              <div className="toc-t">Versi saat ini</div>
              <span className="pill p-blue">v{doc.versionLabel}</span>
              <p className="sub tiny mt20">
                {doc.approvedAt
                  ? `Disetujui ${formatDate(doc.approvedAt)}`
                  : 'Draft belum disetujui'}
              </p>
              <a className="btn btn-sm full-width mt20" href="#main-content">
                Kembali ke awal
              </a>
              {versions.length > 1 && (
                <Link
                  className="btn btn-sm full-width mt20"
                  href={`/dokumen/${doc.id}/${doc.slug}/versi`}
                >
                  Bandingkan versi
                </Link>
              )}
              <p className="sub tiny">
                Pilih versi immutable pada panel Versi & Persetujuan di bawah dokumen.
                Diff/rollback: V1.
              </p>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
