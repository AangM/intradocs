import { requireActor } from '@/lib/session';
import { listCategories } from '@intradocs/db/queries';
import { listTaImports } from '@intradocs/db/ta';
import { formatDate } from '@intradocs/core';
import { PageHeading } from '@/components/shared';
import { TaImport, TaReviewQueue } from '@/components/ta-import';
export const dynamic = 'force-dynamic';

const STATE: Record<string, { text: string; pill: string }> = {
  applied: { text: 'Diterapkan', pill: 'p-green' },
  rejected: { text: 'Ditolak', pill: 'p-red' },
  withdrawn: { text: 'Ditarik', pill: 'p-grey' },
};

export default async function TaImportPage() {
  const actor = await requireActor('taxonomy.view');
  const categories = (await listCategories(actor.id)).map((c) => ({ id: c.id, name: c.name }));
  const imports = await listTaImports(actor.id);
  const pending = imports.filter((i) => i.state === 'pending');
  const done = imports.filter((i) => i.state !== 'pending');
  return (
    <div className="pad">
      <PageHeading
        title="Impor model dari Sparx EA"
        subtitle="Alurnya sama dengan dokumen: berkas dipindai dan disimpan, perubahan diajukan, lalu disetujui admin lain sebelum mengubah model."
      />
      <TaImport categories={categories} />
      <TaReviewQueue
        actorId={actor.id}
        items={pending.map((i) => ({
          id: i.id,
          filename: i.filename,
          format: i.format,
          categoryName: i.categoryName,
          importedAt: formatDate(i.importedAt),
          importedBy: i.importedBy,
          importedById: i.importedById,
          summary: i.summary,
          diff: i.diff,
        }))}
      />
      <section className="card card-b mt20">
        <h2 className="h3">Riwayat impor</h2>
        {done.length ? (
          <div className="table-scroll" tabIndex={0} role="region" aria-label="Riwayat impor">
            <table className="tbl">
              <thead>
                <tr>
                  <th scope="col">Berkas</th>
                  <th scope="col">Status</th>
                  <th scope="col">Diajukan</th>
                  <th scope="col">Diputuskan</th>
                  <th scope="col">Hasil</th>
                </tr>
              </thead>
              <tbody>
                {done.map((i) => (
                  <tr key={i.id}>
                    <td>
                      <a href={`/api/ta/import/${i.id}/original`}>{i.filename}</a>{' '}
                      <span className="pill p-grey">{i.format.toUpperCase()}</span>
                      <div className="sub tiny">{i.categoryName}</div>
                    </td>
                    <td>
                      <span className={`pill ${STATE[i.state]?.pill ?? 'p-grey'}`}>
                        {STATE[i.state]?.text ?? i.state}
                      </span>
                    </td>
                    <td className="sub">
                      {i.importedBy ?? '—'}
                      <div className="tiny">{formatDate(i.importedAt)}</div>
                    </td>
                    <td className="sub">
                      {i.decidedBy ?? '—'}
                      {i.decidedAt && <div className="tiny">{formatDate(i.decidedAt)}</div>}
                      {i.decisionNote && <div className="tiny">“{i.decisionNote}”</div>}
                    </td>
                    <td className="sub">
                      {i.state === 'applied'
                        ? `${i.summary.created ?? 0} baru · ${i.summary.updated ?? 0} berubah · ${i.summary.unchanged ?? 0} sama · ${i.summary.relations ?? 0} relasi${i.summary.relationsRemoved ? ` (−${i.summary.relationsRemoved})` : ''}`
                        : `${i.summary.elements ?? 0} elemen diusulkan`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="sub">Belum ada impor yang diputuskan.</p>
        )}
      </section>
    </div>
  );
}
