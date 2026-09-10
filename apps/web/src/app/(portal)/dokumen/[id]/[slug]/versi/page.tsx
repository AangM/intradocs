import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireActor } from '@/lib/session';
import { parseUuid, InputError } from '@intradocs/core/validation';
import { formatDate } from '@intradocs/core';
import { readDocument } from '@intradocs/db/queries';
import { comparableVersions } from '@intradocs/db/versions';
import { compareVersions } from '@/lib/versions';
import { PageHeading } from '@/components/shared';
import { Icon } from '@/components/icon';
import { RollbackButton } from '@/components/rollback-button';

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
      <div className="pad">
        <PageHeading title="Bandingkan versi" subtitle={doc.title} />
        <p className="sub">
          Dokumen ini baru memiliki satu versi, jadi belum ada yang dapat dibandingkan.
        </p>
        <p>
          <Link href={`/dokumen/${doc.id}/${doc.slug}`}>Kembali ke dokumen</Link>
        </p>
      </div>
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
    <div className="pad">
      <PageHeading
        title="Bandingkan versi"
        subtitle={doc.title}
        actions={
          <Link className="btn" href={`/dokumen/${doc.id}/${doc.slug}`}>
            <Icon name="book" size={16} />
            Kembali ke dokumen
          </Link>
        }
      />

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

      <p className="sub tiny">
        v{left.label} → v{right.label} · {diff.added} baris ditambahkan, {diff.removed} dihapus.
        {diff.truncated
          ? ' Perubahan terlalu besar untuk disejajarkan baris demi baris; ditampilkan sebagai blok.'
          : ''}
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
              Ini membuat draft baru berisi teks v{left.label}. Tidak ada yang diterbitkan langsung
              dan histori tidak diubah: draft tetap harus melewati review seperti revisi lain.
            </p>
            <RollbackButton documentId={doc.id} versionId={left.id} label={left.label} />
          </div>
        </section>
      )}
    </div>
  );
}
