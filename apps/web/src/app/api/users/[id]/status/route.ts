import { NextResponse } from 'next/server';
import { getPool } from '@intradocs/db';
import { readBoundedText } from '@intradocs/core/http-input';
import { setUserActive } from '@intradocs/db/queries';
import {
  assertSameOrigin,
  parseUuid,
  parseStatusBody,
  InputError,
} from '@intradocs/core/validation';
import { readRuntimeConfig } from '@intradocs/core/config';
import { requireApiActor } from '@/lib/session';
import { apiError, PRIVATE_HEADERS } from '@/lib/http';
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request.headers.get('origin'), readRuntimeConfig(process.env).appUrl);
    const actor = await requireApiActor('users.manage');
    const id = parseUuid((await context.params).id);
    if (!request.headers.get('content-type')?.startsWith('application/json'))
      throw new InputError('Gunakan JSON.');
    const text = await readBoundedText(request, 256);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new InputError('JSON tidak valid.');
    }
    const { active } = parseStatusBody(json);
    await setUserActive(actor, id, active);
    // RLS already blocks inactive accounts even if deleting old sessions fails.
    if (!active) await getPool('auth').query('DELETE FROM auth.session WHERE "userId"=$1', [id]);
    return NextResponse.json({ ok: true }, { headers: PRIVATE_HEADERS });
  } catch (e) {
    return apiError(e);
  }
}
