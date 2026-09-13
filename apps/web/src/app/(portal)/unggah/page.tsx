import { notFound } from 'next/navigation';
import { requireActor } from '@/lib/session';
import { scannerStatus } from '@/lib/scanner';
import { uploadCategories } from '@intradocs/db/uploads';
import { readDocument } from '@intradocs/db/queries';
import { versionSummaries } from '@intradocs/db/workflow';
import { parseUuid } from '@intradocs/core/validation';
import { UPLOAD_LIMITS } from '@intradocs/core/uploads';
import { PageHeading } from '@/components/shared';
import { UploadForm, type RevisionInput } from '@/components/upload-form';
export default async function Upload({
  searchParams,
}: {
  searchParams: Promise<{ document?: string; base?: string; topik?: string }>;
}) {
  const actor = await requireActor('documents.upload');
  const params = await searchParams;
  let revision: RevisionInput | undefined;
  if (params.document || params.base) {
    let id: string, base: string;
    try {
      id = parseUuid(params.document);
      base = parseUuid(params.base);
    } catch {
      notFound();
    }
    const doc = await readDocument(actor.id, id, base);
    const versions = await versionSummaries(actor.id, id);
    if (!doc || doc.ownerId !== actor.id || doc.status === 'withdrawn' || versions[0]?.id !== base)
      notFound();
    revision = {
      documentId: id,
      baseVersionId: base,
      title: doc.title,
      summary: doc.summary,
      categoryId: doc.categoryId,
      labels: doc.labels,
      classification: doc.classification,
    };
  }
  // A knowledge gap handed over from the dashboard: only a title seed, nothing else.
  const topic = typeof params.topik === 'string' ? params.topik.trim().slice(0, 80) : '';
  const [categories, scanner] = await Promise.all([uploadCategories(actor.id), scannerStatus()]);
  return (
    <div className="pad upload-page">
      <PageHeading
        title={revision ? 'Revisi Dokumen' : 'Unggah Knowledge'}
        subtitle="Pilih berkas, lengkapi metadata, simpan sebagai draft, lalu ajukan review."
      />
      <UploadForm
        categories={categories}
        ownerName={actor.name}
        maxFileBytes={UPLOAD_LIMITS.binaryBytes}
        initialScanner={scanner}
        revision={revision}
        initialTitle={topic}
      />
    </div>
  );
}
