import { NextResponse } from 'next/server';
import { requireApiActor } from '@/lib/session';
import { PRIVATE_HEADERS, apiError } from '@/lib/http';
import { getStorage } from '@/lib/storage';
import { getScanner } from '@/lib/scanner';
import { readRuntimeConfig } from '@intradocs/core/config';
import { assertSameOrigin } from '@intradocs/core/validation';
import { parseUploadRequest } from '@intradocs/core/upload-request';
import { ingestDraft } from '@intradocs/core/draft-ingestion';
import { LocalDocumentConverter } from '@intradocs/core/converter';
import { PostgresDraftRepository } from '@intradocs/db/uploads';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  try {
    const actor = await requireApiActor('documents.upload');
    assertSameOrigin(request.headers.get('origin'), readRuntimeConfig(process.env).appUrl);
    const input = await parseUploadRequest(request);
    const result = await ingestDraft(
      { ...input, actor, signal: request.signal },
      {
        repository: new PostgresDraftRepository(),
        scanner: getScanner(),
        storage: getStorage(),
        converter: new LocalDocumentConverter(process.env),
      },
    );
    return NextResponse.json(result, {
      status: result.reused ? 200 : 201,
      headers: PRIVATE_HEADERS,
    });
  } catch (error) {
    return apiError(error);
  }
}
