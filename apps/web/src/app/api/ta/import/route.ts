import { createHash, randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { requireApiActor } from '@/lib/session';
import { apiError, PRIVATE_HEADERS } from '@/lib/http';
import { getScanner } from '@/lib/scanner';
import { getStorage } from '@/lib/storage';
import { readRuntimeConfig } from '@intradocs/core/config';
import { assertSameOrigin, InputError, parseUuid } from '@intradocs/core/validation';
import { parseTaImport, TaParseError } from '@intradocs/core/ta';
import { diffTaImport, submitTaImport } from '@intradocs/db/ta';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX = 5 * 1024 * 1024;

/**
 * A Sparx EA export (XMI) or the CSV template for one category, the same way a document
 * arrives: ClamAV first, then parse. mode=preview shows the diff and writes nothing;
 * mode=submit stores the original immutably and proposes the change set for review by a
 * second admin. Nothing here changes the model -- only an approval does.
 */
export async function POST(request: Request) {
  try {
    const actor = await requireApiActor('taxonomy.view');
    assertSameOrigin(request.headers.get('origin'), readRuntimeConfig(process.env).appUrl);
    const length = Number(request.headers.get('content-length') ?? '0');
    if (!length || length > MAX + 64 * 1024) throw new InputError('Berkas maksimal 5 MB.');
    const form = await request.formData();
    const file = form.get('file');
    const mode = form.get('mode');
    if (!(file instanceof File) || file.size === 0 || file.size > MAX)
      throw new InputError('Pilih berkas XMI atau CSV (maksimal 5 MB).');
    if (mode !== 'preview' && mode !== 'submit') throw new InputError('Mode tidak dikenal.');
    const categoryId = parseUuid(String(form.get('categoryId') ?? ''));
    const bytes = new Uint8Array(await file.arrayBuffer());
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    // Every uploaded file is scanned before anything reads it, as for documents.
    const scan = await getScanner().scan(bytes, request.signal);
    let parsed;
    try {
      parsed = parseTaImport(file.name, Buffer.from(bytes).toString('utf8'));
    } catch (e) {
      if (e instanceof TaParseError) throw new InputError(e.message);
      throw e;
    }
    if (!parsed.elements.length)
      throw new InputError('Tidak ada elemen Technology Architecture di berkas ini.');
    const kinds = parsed.elements.reduce<Record<string, number>>((acc, e) => {
      acc[e.kind] = (acc[e.kind] ?? 0) + 1;
      return acc;
    }, {});
    const { diff, ...counts } = await diffTaImport(actor.id, categoryId, parsed);
    if (mode === 'preview')
      return NextResponse.json(
        {
          format: parsed.format,
          sha256,
          elements: parsed.elements.length,
          relations: parsed.relations.length,
          kinds,
          skipped: parsed.skipped.slice(0, 50),
          skippedTotal: parsed.skipped.length,
          diff: diff.slice(0, 200),
          ...counts,
        },
        { headers: PRIVATE_HEADERS },
      );
    if (form.get('sha256') !== sha256)
      throw new InputError('Berkas berbeda dari yang dipratinjau. Pratinjau ulang dulu.');
    const blobKey = `ta-imports/${randomUUID()}/original.${parsed.format === 'xmi' ? 'xmi' : 'csv'}`;
    await getStorage().putImmutable(blobKey, bytes);
    const id = await submitTaImport(actor.id, {
      categoryId,
      parsed,
      diff,
      filename: file.name,
      format: parsed.format,
      sha256,
      blobKey,
      scan,
    });
    return NextResponse.json(
      { ok: true, id, state: 'pending' },
      { status: 201, headers: PRIVATE_HEADERS },
    );
  } catch (error) {
    return apiError(error);
  }
}
