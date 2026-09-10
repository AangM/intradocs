import { NextResponse } from 'next/server';
import { hasCapability } from '@intradocs/core';
import { requireApiActor } from '@/lib/session';
import { apiError, PRIVATE_HEADERS } from '@/lib/http';
import { getAiConfig, aiStatus } from '@/lib/rag';
import { WeknoraClient } from '@intradocs/core/weknora';

export const dynamic = 'force-dynamic';

/**
 * Readiness for the RAG path. The API key never appears, and no upstream error body is
 * echoed -- only a status. Endpoint origin and knowledge base ID are operational details,
 * so they go to operators with analytics.view and not to every signed-in viewer.
 */
export async function GET() {
  try {
    const actor = await requireApiActor();
    const config = getAiConfig();
    const full = aiStatus();
    // Viewers learn whether the assistant works; operators also learn what it is bound to.
    const status = hasCapability(actor, 'analytics.view')
      ? full
      : { retrieval: full.retrieval, generation: full.generation };
    if (config.retrieval !== 'weknora-local' || !config.weknora)
      return NextResponse.json({ ...status, engine: 'disabled' }, { headers: PRIVATE_HEADERS });
    const client = new WeknoraClient(config.weknora);
    const [alive, knowledgeBase] = await Promise.all([
      client.health(),
      client.knowledgeBaseReachable(),
    ]);
    return NextResponse.json(
      { ...status, engine: alive ? 'ok' : 'unreachable', knowledgeBase },
      { status: alive && knowledgeBase ? 200 : 503, headers: PRIVATE_HEADERS },
    );
  } catch (error) {
    return apiError(error);
  }
}
