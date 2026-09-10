import { NextResponse } from 'next/server';
import { getPool } from '@intradocs/db';
export const dynamic = 'force-dynamic';
export async function GET() {
  try {
    await getPool().query('SELECT 1 FROM app.documents LIMIT 0');
    return NextResponse.json(
      { status: 'ok', profile: 'local-dev', ai: 'off', release: '0.3.0' },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch {
    return NextResponse.json(
      { status: 'unavailable' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
