import 'server-only';
import { NextResponse } from 'next/server';
import type { Actor, Capability } from '@intradocs/core';
import { InputError, assertSameOrigin } from '@intradocs/core/validation';
import { readBoundedText } from '@intradocs/core/http-input';
import { readRuntimeConfig } from '@intradocs/core/config';
import { requireApiActor } from './session';
import { apiError, PRIVATE_HEADERS } from './http';
export async function mutation(
  request: Request,
  capability: Capability | undefined,
  run: (actor: Actor, body: unknown) => Promise<unknown>,
) {
  try {
    const actor = await requireApiActor(capability);
    assertSameOrigin(request.headers.get('origin'), readRuntimeConfig(process.env).appUrl);
    if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json')
      throw new InputError('Gunakan JSON.');
    let body: unknown;
    try {
      body = JSON.parse(await readBoundedText(request, 16384));
    } catch (error) {
      if (error instanceof SyntaxError) throw new InputError('JSON tidak valid.');
      throw error;
    }
    const result = await run(actor, body);
    return NextResponse.json(result ?? { ok: true }, { headers: PRIVATE_HEADERS });
  } catch (error) {
    return apiError(error);
  }
}
