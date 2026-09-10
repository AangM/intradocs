import { NextResponse } from 'next/server';
import { requireApiActor } from '@/lib/session';
import { apiError, PRIVATE_HEADERS } from '@/lib/http';
import { getAiConfig, aiStatus } from '@/lib/rag';
import { WeknoraClient } from '@intradocs/core/weknora';

export const dynamic = 'force-dynamic';

/**
 * Readiness for the RAG path. Reports whether the engine answers, never how to reach it:
 * no base URL, no key, no knowledge base ID and no upstream error body appear here.
 * Requires a session, so an unauthenticated probe cannot map the deployment.
 */
export async function GET() {
  try {
    await requireApiActor();
    const config = getAiConfig();
    const status = aiStatus();
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
