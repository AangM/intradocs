import { relatedDocuments } from '@intradocs/db/discovery';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { requireActor } from '@/lib/session';
import { getStorage } from '@/lib/storage';
import { readDocument } from '@intradocs/db/queries';
import { readSourceMetadata } from '@intradocs/db/uploads';
import { withActor } from '@intradocs/db';
import { parseUuid } from '@intradocs/core/validation';
import { formatDate, hasCapability, initials } from '@intradocs/core';
import { getOutline } from '@/lib/markdown';
import { DocumentBody } from '@/components/document-body';
import { ClassificationBadge, Notice, StatusBadge, documentHref } from '@/components/shared';
import { Icon } from '@/components/icon';
import { DocumentAccess } from '@/components/document-access';
import { documentAccessCandidates } from '@intradocs/db/workflow';
import { AttachmentsList } from '@/components/attachments-list';
import { WorkflowPanel } from '@/components/workflow-panel';
import { ReaderFeedback, FavoriteButton } from '@/components/reader-feedback';
import { LabelSuggestions } from '@/components/label-suggestions';
import { DocumentInsights } from '@/components/document-insights';
import { RequiredReadingMark } from '@/components/required-reading-mark';
import { ReaffirmButton } from '@/components/reaffirm-button';
import { reviewInfo, versionSummaries, readerPreferences } from '@intradocs/db/workflow';
import { findSensitiveContent } from '@intradocs/core/workflow';
/** Older versions in the side panel, in a reader's words rather than the state enum. */
const VERSION_STATE: Record<string, string> = {
  approved: 'versi lama',
  draft: 'draft',
  in_review: 'menunggu review',
  changes_requested: 'perlu revisi',
  rejected: 'ditolak',
};
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
  // ~200 words a minute; shown as an estimate, never as a fact about the reader.
  const readingMinutes = Math.max(
    1,
    Math.round(markdown.split(/\s+/).filter(Boolean).length / 200),
  );
  const reviewerStep = info?.steps.find((s) => s.reviewerId === actor.id && !s.decision);
  const ownerDraft =
    actor.id === doc.ownerId && doc.status === 'draft' && versions[0]?.id === doc.versionId;
  // The owner's reaffirmation applies to the current published version whose review is
  // within 30 days or past (the database enforces the same window); an expired version
  // is past reaffirming and gets the expiry notice instead.
  const reviewDue =
    actor.id === doc.ownerId &&
    doc.status === 'published' &&
    !expired &&
    doc.reviewAt !== null &&
    Date.parse(doc.reviewAt) <= Date.now() + 30 * 86_400_000;
  // The workflow panel is open when this actor has something to do on this version;
  // otherwise it lives under the collapsed owner/reviewer tools below the article.
  const workflowOpen = Boolean(reviewerStep || ownerDraft);
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
          Berkas asli: {source ? source.name : 'contoh bawaan'}
          <br />
          <span>Setiap versi tersimpan apa adanya dan tidak bisa diubah.</span>
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
                  Disetujui: {doc.approvedBy}
                </span>
              )}
              <span className="sub tiny doc-meta-right">
                <Icon name="clock" size={13} /> ±{readingMinutes} menit baca
              </span>
            </div>
            <div className="reader-actions">
              <a className="btn btn-sm" href={`/api/files/${doc.versionId}/markdown`}>
                <Icon name="download" size={15} />
                Unduh Markdown
              </a>
              <Link className="btn btn-sm" href={`/ai-assistant?doc=${id}`}>
                <Icon name="spark" size={15} />
                Tanya AI tentang dokumen ini
              </Link>
              {doc.status === 'published' && !expired && (
                <FavoriteButton documentId={id} initialFavorite={preferences.favorite} />
              )}
              <span className="reader-labels">
                {doc.labels.map((t) => (
                  <Link className="tag" key={t} href={`/katalog?label=${encodeURIComponent(t)}`}>
                    {t}
                  </Link>
                ))}
              </span>
            </div>
            {reviewDue && doc.reviewAt && (
              <ReaffirmButton
                versionId={doc.versionId}
                reviewAt={formatDate(doc.reviewAt)}
                overdue={Date.parse(doc.reviewAt) <= Date.now()}
              />
            )}
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
            ) : null}
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
              <p className="hint">Dokumen lain di kategori ini yang boleh Anda baca.</p>
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
            {/* Generated questions for every reader; the draft summary only for those who
                could revise. The route enforces the same split server-side. */}
            {doc.status === 'published' && !expired && (
              <DocumentInsights documentId={id} editor={hasCapability(actor, 'documents.upload')} />
            )}
            {doc.status === 'published' && !expired && (
              <ReaderFeedback versionId={doc.versionId} initialFeedback={preferences.feedback} />
            )}
            {info && workflowOpen && (
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
            {/* Owner, reviewer and taxonomy tools, folded away for readers who only came
                to read: label suggestions need documents.upload (taking one up is a
                revision), required reading needs taxonomy.view, and the version panel is
                the same one shown open above when there is something to decide. */}
            {(hasCapability(actor, 'documents.upload') ||
              hasCapability(actor, 'taxonomy.view') ||
              (info && !workflowOpen)) && (
              <details className="editor-tools">
                <summary>
                  <Icon name="settings" size={15} />
                  Alat pemilik, reviewer & taksonomi
                  <span className="sub tiny">versi, persetujuan, saran label, bacaan wajib</span>
                </summary>
                <div className="editor-tools-body">
                  {hasCapability(actor, 'documents.upload') && <LabelSuggestions documentId={id} />}
                  {hasCapability(actor, 'taxonomy.view') && doc.status === 'published' && (
                    <RequiredReadingMark
                      documentId={id}
                      categoryId={doc.categoryId}
                      categoryName={doc.categoryName}
                    />
                  )}
                  {info && !workflowOpen && (
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
                </div>
              </details>
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
              <div className="toc-t">Riwayat versi</div>
              <ul className="version-list">
                {versions.slice(0, 4).map((v) => (
                  <li key={v.id}>
                    <Link
                      prefetch={false}
                      href={`/dokumen/${doc.id}/${doc.slug}?version=${v.id}`}
                      className={`pill ${v.id === doc.versionId ? 'p-blue' : 'p-grey'}`}
                      aria-current={v.id === doc.versionId ? 'true' : undefined}
                    >
                      v{v.label}
                    </Link>
                    <span className="sub tiny">
                      {v.active
                        ? formatDate(v.createdAt)
                        : (VERSION_STATE[v.reviewState] ?? v.reviewState)}
                    </span>
                  </li>
                ))}
              </ul>
              {versions.length > 4 && (
                <p className="sub tiny">+{versions.length - 4} versi lebih lama di panel versi.</p>
              )}
              <p className="sub tiny">
                {doc.approvedAt ? `Disetujui ${formatDate(doc.approvedAt)}.` : 'Belum disetujui.'}
                {doc.reviewAt ? ` Ditinjau ulang ${formatDate(doc.reviewAt)}.` : ''}
              </p>
              {versions.length > 1 && (
                <Link
                  className="btn btn-sm full-width"
                  href={`/dokumen/${doc.id}/${doc.slug}/versi`}
                >
                  Bandingkan versi
                </Link>
              )}
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
