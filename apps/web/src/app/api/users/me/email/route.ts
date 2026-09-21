import { NextResponse } from 'next/server';
import { readBoundedText } from '@intradocs/core/http-input';
import { setEmailNotifications } from '@intradocs/db/queries';
import { assertSameOrigin, InputError } from '@intradocs/core/validation';
import { readRuntimeConfig } from '@intradocs/core/config';
import { requireApiActor } from '@/lib/session';
import { apiError, PRIVATE_HEADERS } from '@/lib/http';
/** The person's own switch for email digests; nothing else about the profile moves here. */
export async function PATCH(request: Request) {
  try {
    assertSameOrigin(request.headers.get('origin'), readRuntimeConfig(process.env).appUrl);
    const actor = await requireApiActor();
    if (!request.headers.get('content-type')?.startsWith('application/json'))
      throw new InputError('Gunakan JSON.');
    let json: unknown;
    try {
      json = JSON.parse(await readBoundedText(request, 128));
    } catch {
      throw new InputError('JSON tidak valid.');
    }
    const o = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
    if (Object.keys(o).some((k) => k !== 'enabled')) throw new InputError('Field tidak dikenal.');
    if (typeof o.enabled !== 'boolean') throw new InputError('enabled harus boolean.');
    await setEmailNotifications(actor.id, o.enabled);
    return NextResponse.json({ ok: true, enabled: o.enabled }, { headers: PRIVATE_HEADERS });
  } catch (e) {
    return apiError(e);
  }
}
