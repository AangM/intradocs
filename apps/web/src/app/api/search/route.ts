import { NextResponse } from 'next/server';
import { requireApiActor } from '@/lib/session';
import { apiError, PRIVATE_HEADERS } from '@/lib/http';
import { parseCatalogQuery } from '@intradocs/core/validation';
import { searchDocuments } from '@intradocs/db/discovery';
export async function GET(request: Request) {
  try {
    const actor = await requireApiActor();
    const params = new URL(request.url).searchParams;
    const raw: Record<string, string | string[]> = {};
    for (const key of new Set(params.keys())) {
      const a = params.getAll(key);
      raw[key] = a.length === 1 ? a[0]! : a;
    }
    return NextResponse.json(
      await searchDocuments(actor.id, { ...parseCatalogQuery(raw), status: 'published' }),
      { headers: PRIVATE_HEADERS },
    );
  } catch (error) {
    return apiError(error);
  }
}
