import { requireApiActor } from '@/lib/session';
import { apiError, PRIVATE_HEADERS } from '@/lib/http';
import { getStorage } from '@/lib/storage';
import { parseUuid } from '@intradocs/core/validation';
import { taImportFile } from '@intradocs/db/ta';
import { NextResponse } from 'next/server';

/** The original Sparx export an import was proposed from, byte for byte, hash-checked. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireApiActor('taxonomy.view');
    const id = parseUuid((await context.params).id);
    const file = await taImportFile(actor.id, id);
    if (!file)
      return NextResponse.json(
        { error: 'Tidak ditemukan.' },
        { status: 404, headers: PRIVATE_HEADERS },
      );
    const bytes = await getStorage().read(file.blob_key, file.sha256);
    const safe = file.filename.replace(/[^\w.-]+/g, '_');
    return new Response(Buffer.from(bytes), {
      headers: {
        ...PRIVATE_HEADERS,
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${safe}"`,
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (e) {
    return apiError(e);
  }
}
