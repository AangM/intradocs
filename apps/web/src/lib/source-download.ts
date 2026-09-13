import 'server-only';
import { NextResponse } from 'next/server';
import { requireApiActor } from './session';
import { apiError, PRIVATE_HEADERS } from './http';
import { getStorage } from './storage';
import { parseUuid } from '@intradocs/core/validation';
import { withActor } from '@intradocs/db';
import { readUploadArtifact } from '@intradocs/db/uploads';
export async function downloadSource(rawId: string, kind: 'original' | 'provenance') {
  try {
    const actor = await requireApiActor();
    let id: string;
    try {
      id = parseUuid(rawId);
    } catch {
      return NextResponse.json(
        { error: 'Berkas tidak tersedia.' },
        { status: 404, headers: PRIVATE_HEADERS },
      );
    }
    const artifact = await readUploadArtifact(actor.id, id, kind);
    if (!artifact)
      return NextResponse.json(
        { error: 'Berkas tidak tersedia.' },
        { status: 404, headers: PRIVATE_HEADERS },
      );
    const bytes = await getStorage().read(artifact.key, artifact.hash);
    const allowed = await withActor(
      actor.id,
      async ({ client }) =>
        (await client.query<{ ok: boolean }>('SELECT app.can_read_version($1) AS ok', [id])).rows[0]
          ?.ok === true,
    );
    if (!allowed)
      return NextResponse.json(
        { error: 'Berkas tidak tersedia.' },
        { status: 404, headers: PRIVATE_HEADERS },
      );
    return new Response(new Uint8Array(bytes), {
      headers: {
        ...PRIVATE_HEADERS,
        'Content-Type':
          kind === 'original'
            ? ({
                PDF: 'application/pdf',
                DOCX: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                XLSX: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                PPTX: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
              }[artifact.format] ?? 'text/plain; charset=utf-8')
            : 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="intradocs-${id}-${kind}.${artifact.format.toLowerCase()}"`,
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': 'sandbox',
        'Content-Length': String(bytes.length),
      },
    });
  } catch (error) {
    return apiError(error);
  }
}
