import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireActor } from '@/lib/session';
import { parseUuid, InputError } from '@intradocs/core/validation';
import { formatDate } from '@intradocs/core';
import { readDocument } from '@intradocs/db/queries';
import { comparableVersions } from '@intradocs/db/versions';
import { compareVersions } from '@/lib/versions';
import { Empty, documentHref } from '@/components/shared';
import { Icon } from '@/components/icon';
import { RollbackButton } from '@/components/rollback-button';

/**
 * The compare page wears the reader's shell (document rail on the left, one article
 * card) so a person never leaves the document's frame to look at its history.
 */
function VersionShell({
  doc,
  versions,
  children,
}: {
  doc: {
    id: string;
    slug: string;
    title: string;
    categoryName: string;
    versionLabel: string;
    format: string;
  };
  versions: Array<{ id: string; label: string; active: boolean }>;
  children: React.ReactNode;
}) {
  return (
    <div className="reader-page versi-page">
      <aside className="docnav" aria-label="Navigasi dokumen">
        <Link className="back-link" href={documentHref(doc)}>
          <Icon name="chev-r" size={12} style={{ transform: 'rotate(180deg)' }} />
          Kembali ke dokumen
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
        <div className="dn-sec">Versi</div>
        {versions.map((v) => (
          <Link
            key={v.id}
            className="dn-i"
            href={`/dokumen/${doc.id}/${doc.slug}?version=${v.id}`}
            prefetch={false}
          >
            v{v.label}
            {v.active ? ' · aktif' : ''}
          </Link>
        ))}
        <div className="local-note">
          Setiap versi tersimpan apa adanya.
          <br />
          <span>Memulihkan versi lama membuat draft baru yang tetap direview.</span>
        </div>
      </aside>
      <div className="doc-main">
        <div className="doc-columns">
          <article className="doc-wrap">{children}</article>
        </div>
      </div>
    </div>
  );
}

export default async function VersionCompare({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; slug: string }>;
  searchParams: Promise<{ left?: string; right?: string }>;
}) {
  const actor = await requireActor();
  const route = await params;
  let id: string;
  try {
    id = parseUuid(route.id);
  } catch {
    notFound();
  }
  const doc = await readDocument(actor.id, id);
  if (!doc) notFound();
  const versions = await comparableVersions(actor.id, id);
  if (versions.length < 2)
    return (
      <VersionShell doc={doc} versions={versions}>
        <nav className="crumbs" aria-label="Breadcrumb">
          <Link href={documentHref(doc)}>{doc.title}</Link>
          <Icon name="chev-r" size={12} />
          <span>Riwayat versi</span>
        </nav>
        <h1>Bandingkan versi</h1>
        <div className="versi-empty">
          <Empty title="Baru satu versi">
            Perbandingan muncul setelah revisi pertama disetujui.
            <br />
            <Link className="btn btn-sm" href={documentHref(doc)}>
              <Icon name="book" size={14} />
              Kembali ke dokumen
            </Link>
          </Empty>
        </div>
      </VersionShell>
    );

  const query = await searchParams;
  // Default to the two newest versions, which is the comparison a reader almost always
  // wants after a revision lands.
  let rightId = versions[0]!.id;
  let leftId = versions[1]!.id;
  try {
    if (query.right) rightId = parseUuid(query.right);
    if (query.left) leftId = parseUuid(query.left);
  } catch (error) {
    if (!(error instanceof InputError)) throw error;
    notFound();
  }
  const comparison = await compareVersions(actor, id, leftId, rightId);
  if (!comparison) notFound();
  const { left, right, diff } = comparison;
  const ownsDocument = doc.ownerId === actor.id;
  const restorable = ownsDocument && left.reviewState === 'approved' && !left.active;

  return (
    <VersionShell doc={doc} versions={versions}>
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link href={documentHref(doc)}>{doc.title}</Link>
        <Icon name="chev-r" size={12} />
        <span>Riwayat versi</span>
      </nav>
      <h1>Bandingkan versi</h1>

      <form className="diff-picker" method="get">
        <label htmlFor="left">Versi lama</label>
        <select id="left" name="left" defaultValue={left.id}>
          {versions.map((v) => (
            <option key={v.id} value={v.id}>
              v{v.label} · {formatDate(v.createdAt)}
              {v.active ? ' · aktif' : ''}
            </option>
          ))}
        </select>
        <label htmlFor="right">Versi baru</label>
        <select id="right" name="right" defaultValue={right.id}>
          {versions.map((v) => (
            <option key={v.id} value={v.id}>
              v{v.label} · {formatDate(v.createdAt)}
              {v.active ? ' · aktif' : ''}
            </option>
          ))}
        </select>
        <button className="btn btn-p" type="submit">
          Bandingkan
        </button>
      </form>

      <p className="diff-summary">
        <span className="pill p-grey">
          v{left.label} → v{right.label}
        </span>
        <span className="pill p-green">+{diff.added} baris</span>
        <span className="pill p-red">−{diff.removed} baris</span>
        {diff.truncated && (
          <span>
            Perubahan terlalu besar untuk disejajarkan baris demi baris; ditampilkan sebagai blok.
          </span>
        )}
      </p>

      {diff.identical ? (
        <p className="sub">Kedua versi memiliki isi yang sama persis.</p>
      ) : (
        <div className="diff-view">
          {diff.hunks.map((hunk) => (
            <table className="diff-hunk" key={`${hunk.leftStart}-${hunk.rightStart}`}>
              <caption className="sr-only">
                Perubahan mulai baris {hunk.leftStart} pada versi lama
              </caption>
              {/* Fixed layout reads its column widths from here; without a colgroup the
                  visually-hidden caption made Chrome split every column equally. */}
              <colgroup>
                <col className="diff-col-num" />
                <col className="diff-col-num" />
                <col className="diff-col-sign" />
                <col />
              </colgroup>
              <tbody>
                {hunk.lines.map((line, index) => (
                  <tr className={`diff-${line.op}`} key={`${line.left}-${line.right}-${index}`}>
                    <td className="diff-num">{line.left ?? ''}</td>
                    <td className="diff-num">{line.right ?? ''}</td>
                    <td className="diff-sign" aria-hidden="true">
                      {line.op === 'add' ? '+' : line.op === 'remove' ? '−' : ' '}
                    </td>
                    <td className="diff-text">
                      <span className="sr-only">
                        {line.op === 'add'
                          ? 'Ditambahkan: '
                          : line.op === 'remove'
                            ? 'Dihapus: '
                            : 'Tidak berubah: '}
                      </span>
                      {line.text || ' '}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
        </div>
      )}

      {restorable && (
        <section className="callout c-info">
          <Icon name="refresh" size={18} />
          <div>
            <strong>Pulihkan v{left.label}?</strong>
            <p className="sub tiny">
              Membuat draft baru berisi teks v{left.label}; tidak ada yang terbit langsung dan
              histori tidak berubah.
            </p>
            <RollbackButton documentId={doc.id} versionId={left.id} label={left.label} />
          </div>
        </section>
      )}
    </VersionShell>
  );
}
