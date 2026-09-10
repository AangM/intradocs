import { NextResponse } from 'next/server';
import { requireApiActor } from '@/lib/session';
import { apiError, PRIVATE_HEADERS } from '@/lib/http';
import { parseCatalogQuery, InputError } from '@intradocs/core/validation';
import { listDocuments } from '@intradocs/db/queries';
export async function GET(request: Request) {
  try {
    const actor = await requireApiActor();
    const p = new URL(request.url).searchParams;
    for (const key of p.keys())
      if (p.getAll(key).length > 1) throw new InputError('Parameter berulang ditolak.');
    const query = parseCatalogQuery(Object.fromEntries(p));
    return NextResponse.json(await listDocuments(actor.id, query), { headers: PRIVATE_HEADERS });
  } catch (e) {
    return apiError(e);
  }
}
