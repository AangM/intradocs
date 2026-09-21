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

/**
 * The same checks as `mutation`, but the handler writes NDJSON lines through `emit`
 * while it works and the result -- or an error -- is the last line. Once the first
 * byte is out the HTTP status is fixed at 200, so a failure is reported inside the
 * stream as {type:'error', status, message} with the same mapping apiError uses.
 * Nothing is cached, and the body is not readable as a whole by a proxy.
 */
export async function streamingMutation(
  request: Request,
  capability: Capability | undefined,
  run: (actor: Actor, body: unknown, emit: (event: object) => void) => Promise<unknown>,
) {
  let actor: Actor;
  let body: unknown;
  try {
    actor = await requireApiActor(capability);
    assertSameOrigin(request.headers.get('origin'), readRuntimeConfig(process.env).appUrl);
    if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json')
      throw new InputError('Gunakan JSON.');
    try {
      body = JSON.parse(await readBoundedText(request, 16384));
    } catch (error) {
      if (error instanceof SyntaxError) throw new InputError('JSON tidak valid.');
      throw error;
    }
  } catch (error) {
    return apiError(error);
  }
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: object) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          // The client went away; the handler keeps running to store the turn.
        }
      };
      try {
        const result = await run(actor, body, emit);
        emit({ type: 'result', ...(result as object) });
      } catch (error) {
        const mapped = apiError(error);
        const payload = (await mapped.json().catch(() => ({}))) as { error?: string };
        emit({
          type: 'error',
          status: mapped.status,
          message: payload.error ?? 'Permintaan gagal.',
        });
      } finally {
        try {
          controller.close();
        } catch {
          // Already closed by a disconnect.
        }
      }
    },
  });
  return new Response(stream, {
    headers: {
      ...PRIVATE_HEADERS,
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'X-Accel-Buffering': 'no',
    },
  });
}
