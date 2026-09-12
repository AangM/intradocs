import { requireActor } from '@/lib/session';
import { taxonomyData, taxonomySuggestions } from '@intradocs/db/taxonomy';
import { PageHeading, Notice } from '@/components/shared';
import { TaxonomyEditor } from '@/components/taxonomy-editor';
import { TaxonomyRules } from '@/components/taxonomy-rules';
export default async function Taxonomy() {
  const actor = await requireActor('taxonomy.view');
  const [data, suggestions] = await Promise.all([
    taxonomyData(actor.id),
    taxonomySuggestions(actor.id),
  ]);
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
      <TaxonomyEditor {...data} suggestions={suggestions} />
      <TaxonomyRules categories={data.categories} />
    </div>
  );
}
