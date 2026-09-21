import { NextResponse } from 'next/server';
import { getPool } from '@intradocs/db';
import { readAiConfig } from '@intradocs/core/ai-config';
import { readRuntimeConfig } from '@intradocs/core/config';
export const dynamic = 'force-dynamic';
export async function GET() {
  try {
    await getPool().query('SELECT 1 FROM app.documents LIMIT 0');
    return NextResponse.json(
      // Mode names only. This route needs no session, so the endpoint, the key and the
      // knowledge base ID must not appear here -- describeAiConfig() carries all three
      // and belongs behind /api/rag/health instead.
      {
        status: 'ok',
        profile: readRuntimeConfig(process.env).profile,
        // Mode only; issuer and client id stay out of an unauthenticated response.
        auth: readRuntimeConfig(process.env).sso ? 'oidc' : 'local',
        ai: readAiConfig(process.env).retrieval,
        release: '0.3.0',
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch {
    return NextResponse.json(
      { status: 'unavailable' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
