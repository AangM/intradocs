import { NextResponse } from 'next/server';
import { requireApiActor } from '@/lib/session';
import { PRIVATE_HEADERS, apiError } from '@/lib/http';
import { scannerStatus } from '@/lib/scanner';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET() {
  try {
    await requireApiActor('documents.upload');
    return NextResponse.json(await scannerStatus(), { headers: PRIVATE_HEADERS });
  } catch (e) {
    return apiError(e);
  }
}
