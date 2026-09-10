import { requireActor } from '@/lib/session';
import { taxonomyData } from '@intradocs/db/taxonomy';
import { PageHeading, Notice } from '@/components/shared';
import { TaxonomyEditor } from '@/components/taxonomy-editor';
export default async function Taxonomy() {
  const actor = await requireActor('taxonomy.view');
  const data = await taxonomyData(actor.id);
  return (
    <div className="pad">
      <PageHeading
        title="Kategori & Label"
        subtitle="Taksonomi, urutan, klasifikasi minimum, dan aturan review dalam scope Anda."
      />
      <Notice>
        Maksimal tiga tingkat; dokumen berada pada kategori leaf. Pemindahan kategori terpakai dan
        penurunan klasifikasi ditolak karena memerlukan review akses terpisah. Kritikal selalu
        membutuhkan dua tahap.
      </Notice>
      <TaxonomyEditor {...data} />
    </div>
  );
}
