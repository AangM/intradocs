import { NextResponse } from 'next/server';
import { requireApiActor } from '@/lib/session';
import { apiError, PRIVATE_HEADERS } from '@/lib/http';
import { assertSameOrigin, parseUuid } from '@intradocs/core/validation';
import { readRuntimeConfig } from '@intradocs/core/config';
import { readConversation, deleteConversation } from '@intradocs/db/assistant';

/**
 * One thread with its turns. Citations come back only for versions the reader may
 * still open; an answer whose source has since been revoked comes back blank with a
 * count of hidden citations, so the page can say why.
 */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireApiActor();
    const id = parseUuid((await ctx.params).id);
    const conversation = await readConversation(actor.id, id);
    if (!conversation)
      return NextResponse.json(
        { error: 'Percakapan tidak ditemukan.' },
        { status: 404, headers: PRIVATE_HEADERS },
      );
    return NextResponse.json(conversation, { headers: PRIVATE_HEADERS });
  } catch (e) {
    return apiError(e);
  }
}

export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireApiActor();
    assertSameOrigin(request.headers.get('origin'), readRuntimeConfig(process.env).appUrl);
    const id = parseUuid((await ctx.params).id);
    const removed = await deleteConversation(actor.id, id);
    if (!removed)
      return NextResponse.json(
        { error: 'Percakapan tidak ditemukan.' },
        { status: 404, headers: PRIVATE_HEADERS },
      );
    return NextResponse.json({ ok: true }, { headers: PRIVATE_HEADERS });
  } catch (e) {
    return apiError(e);
  }
}
