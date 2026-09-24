import { requireActor } from '@/lib/session';
import { listCategories } from '@intradocs/db/queries';
import { listTaImports } from '@intradocs/db/ta';
import { formatDate } from '@intradocs/core';
import { PageHeading } from '@/components/shared';
import { TaImport } from '@/components/ta-import';
export const dynamic = 'force-dynamic';

export default async function TaImportPage() {
  const actor = await requireActor('taxonomy.view');
  const categories = (await listCategories(actor.id)).map((c) => ({ id: c.id, name: c.name }));
  const imports = await listTaImports(actor.id);
  return (
    <div className="pad">
      <PageHeading
        title="Impor model dari Sparx EA"
        subtitle="Ekspor XMI (Publish › Export XMI 2.1) atau template CSV. Pratinjau dulu, lalu terapkan; tidak ada elemen yang dihapus oleh impor."
      />
      <TaImport categories={categories} />
      <section className="card card-b mt20">
        <h2 className="h3">Riwayat impor</h2>
        {imports.length ? (
          <div className="table-scroll" tabIndex={0} role="region" aria-label="Riwayat impor">
            <table className="tbl">
              <thead>
                <tr>
                  <th scope="col">Berkas</th>
                  <th scope="col">Oleh</th>
                  <th scope="col">Hasil</th>
                  <th scope="col">Waktu</th>
                </tr>
              </thead>
              <tbody>
                {imports.map((i) => (
                  <tr key={i.id}>
                    <td>
                      {i.filename} <span className="pill p-grey">{i.format.toUpperCase()}</span>
                    </td>
                    <td className="sub">{i.by ?? '—'}</td>
                    <td className="sub">
                      {i.summary.created} baru · {i.summary.updated} berubah · {i.summary.unchanged}{' '}
                      sama · {i.summary.relations} relasi
                      {i.summary.relationsRemoved ? ` (−${i.summary.relationsRemoved})` : ''}
                    </td>
                    <td className="sub">{formatDate(i.importedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="sub">Belum ada impor.</p>
        )}
      </section>
    </div>
  );
}
