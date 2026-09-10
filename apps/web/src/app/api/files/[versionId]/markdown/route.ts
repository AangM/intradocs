import { NextResponse } from 'next/server';
import { withActor } from '@intradocs/db';
import { readVersionFile } from '@intradocs/db/queries';
import { parseUuid } from '@intradocs/core/validation';
import { requireApiActor } from '@/lib/session';
import { getStorage } from '@/lib/storage';
import { apiError, PRIVATE_HEADERS } from '@/lib/http';
const missing = () =>
  NextResponse.json({ error: 'Berkas tidak tersedia.' }, { status: 404, headers: PRIVATE_HEADERS });
export async function GET(_request: Request, context: { params: Promise<{ versionId: string }> }) {
  try {
    const actor = await requireApiActor();
    const params = await context.params;
    let id: string;
    try {
      id = parseUuid(params.versionId);
    } catch {
      return missing();
    }
    const ref = await readVersionFile(actor.id, id);
    if (!ref) return missing();
    const bytes = await getStorage().read(ref.key, ref.hash);
    // Authorization is checked again after I/O, before releasing any bytes.
    const allowed = await withActor(
      actor.id,
      async ({ client }) =>
        (
          await client.query<{ allowed: boolean }>('SELECT app.can_read_version($1) AS allowed', [
            id,
          ])
        ).rows[0]?.allowed === true,
    );
    if (!allowed) return missing();
    return new Response(new Uint8Array(bytes), {
      headers: {
        ...PRIVATE_HEADERS,
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="intradocs-${id}.md"`,
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      },
    });
  } catch (e) {
    return apiError(e);
  }
}
