import { withActor } from '@intradocs/db';
export async function AttachmentsList({
  actorId,
  versionId,
}: {
  actorId: string;
  versionId: string;
}) {
  const rows = await withActor(
    actorId,
    async ({ client }) =>
      (
        await client.query<{
          ordinal: number;
          name: string;
          source_format: string;
          original_bytes: number;
        }>(
          'SELECT ordinal,name,source_format,original_bytes FROM app.version_attachments WHERE version_id=$1 ORDER BY ordinal',
          [versionId],
        )
      ).rows,
  );
  if (!rows.length) return null;
  return (
    <section className="source-evidence">
      <h2 className="h3">Lampiran versi ini</h2>
      <p className="sub">
        Isi lampiran disertakan dalam canonical gabungan dan approval yang sama.
      </p>
      <ul>
        {rows.map((a) => (
          <li key={a.ordinal}>
            <a href={`/api/files/${versionId}/attachments/${a.ordinal}`}>Unduh {a.name}</a>{' '}
            <span className="sub">
              {a.source_format} · {(a.original_bytes / 1024).toFixed(1)} KiB
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
