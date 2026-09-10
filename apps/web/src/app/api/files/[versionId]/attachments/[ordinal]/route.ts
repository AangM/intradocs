import { NextResponse } from 'next/server';
import { requireApiActor } from '@/lib/session';
import { getStorage } from '@/lib/storage';
import { apiError, PRIVATE_HEADERS } from '@/lib/http';
import { parseUuid } from '@intradocs/core/validation';
import { withActor } from '@intradocs/db';
import { randomUUID } from 'node:crypto';
const missing = () =>
  NextResponse.json({ error: 'Berkas tidak tersedia.' }, { status: 404, headers: PRIVATE_HEADERS });
export async function GET(
  _request: Request,
  context: { params: Promise<{ versionId: string; ordinal: string }> },
) {
  try {
    const actor = await requireApiActor();
    const params = await context.params;
    let id: string;
    try {
      id = parseUuid(params.versionId);
    } catch {
      return missing();
    }
    if (!/^[1-4]$/.test(params.ordinal)) return missing();
    const item = await withActor(actor.id, async ({ client }) => {
      const r = (
        await client.query<{
          original_key: string;
          original_sha256: string;
          source_format: string;
          document_id: string;
        }>(
          'SELECT a.original_key,a.original_sha256,a.source_format,v.document_id FROM app.version_attachments a JOIN app.document_versions v ON v.id=a.version_id WHERE a.version_id=$1 AND a.ordinal=$2',
          [id, Number(params.ordinal)],
        )
      ).rows[0];
      if (r)
        await client.query(
          "INSERT INTO app.audit_events(actor_id,action,document_id,request_id) VALUES(app.actor_id(),'document.download',$1,$2)",
          [r.document_id, randomUUID()],
        );
      return r;
    });
    if (!item) return missing();
    const bytes = await getStorage().read(item.original_key, item.original_sha256);
    const allowed = await withActor(
      actor.id,
      async ({ client }) =>
        (await client.query<{ ok: boolean }>('SELECT app.can_read_version($1) AS ok', [id])).rows[0]
          ?.ok,
    );
    if (!allowed) return missing();
    return new Response(new Uint8Array(bytes), {
      headers: {
        ...PRIVATE_HEADERS,
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="intradocs-${id}-lampiran-${params.ordinal}.${item.source_format.toLowerCase()}"`,
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      },
    });
  } catch (error) {
    return apiError(error);
  }
}
