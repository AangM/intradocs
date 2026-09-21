import { NextResponse } from 'next/server';
import { requireApiActor } from '@/lib/session';
import { apiError, PRIVATE_HEADERS } from '@/lib/http';
import { assertSameOrigin, parseUuid } from '@intradocs/core/validation';
import { readRuntimeConfig } from '@intradocs/core/config';
import { revokeInvitation } from '@intradocs/db/invitations';

export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireApiActor('users.view');
    assertSameOrigin(request.headers.get('origin'), readRuntimeConfig(process.env).appUrl);
    await revokeInvitation(actor.id, parseUuid((await ctx.params).id));
    return NextResponse.json({ ok: true }, { headers: PRIVATE_HEADERS });
  } catch (e) {
    return apiError(e);
  }
}
