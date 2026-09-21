import { requireActor } from '@/lib/session';
import { taxonomyData, taxonomySuggestions } from '@intradocs/db/taxonomy';
import { PageHeading } from '@/components/shared';
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
        subtitle={`Taksonomi knowledge base — ${data.categories.length} kategori dan ${data.labels.length} label aktif dalam scope Anda`}
      />
      <TaxonomyEditor {...data} suggestions={suggestions} />
      <TaxonomyRules categories={data.categories} />
      <p className="sub tiny mt20">
        Maksimal tiga tingkat; dokumen selalu berada di kategori paling bawah. Menurunkan
        klasifikasi memerlukan review akses terpisah.
      </p>
    </div>
  );
}
