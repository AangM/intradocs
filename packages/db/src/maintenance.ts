import type { PoolClient } from 'pg';
import type { StorageReferences } from '@intradocs/core/orphan-cleanup';
// Only invoked by the local operator command, never by a web/worker connection.
export async function readStorageReferences(client: PoolClient): Promise<StorageReferences> {
  const identity = await client.query<{ allowed: boolean }>(
    'SELECT rolsuper AS allowed FROM pg_roles WHERE rolname=current_user',
  );
  if (identity.rows[0]?.allowed !== true)
    throw new Error(
      'Cleanup wajib menggunakan koneksi admin lokal; RLS-filtered snapshot tidak boleh digunakan.',
    );
  const { rows } = await client.query<{
    key: string;
  }>(`SELECT markdown_key AS key FROM app.document_versions
 UNION SELECT original_key AS key FROM app.version_sources UNION SELECT provenance_key AS key FROM app.version_sources`);
  const receipts = await client.query<{
    directory: string;
  }>(`SELECT 'documents/'||document_id||'/versions/'||version_id AS directory FROM app.upload_requests
 WHERE state='complete' OR (state='processing' AND lease_until>now())`);
  return { keys: rows.map((r) => r.key), activeVersions: receipts.rows.map((r) => r.directory) };
}
