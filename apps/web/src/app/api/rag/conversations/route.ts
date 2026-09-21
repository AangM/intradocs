import { NextResponse } from 'next/server';
import { requireApiActor } from '@/lib/session';
import { apiError, PRIVATE_HEADERS } from '@/lib/http';
import { listConversations } from '@intradocs/db/assistant';

/** The actor's own assistant threads, newest first. RLS returns nobody else's. */
export async function GET() {
  try {
    const actor = await requireApiActor();
    return NextResponse.json(
      { conversations: await listConversations(actor.id) },
      { headers: PRIVATE_HEADERS },
    );
  } catch (e) {
    return apiError(e);
  }
}
