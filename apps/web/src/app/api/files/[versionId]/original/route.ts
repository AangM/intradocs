import { downloadSource } from '@/lib/source-download';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(_request: Request, context: { params: Promise<{ versionId: string }> }) {
  return downloadSource((await context.params).versionId, 'original');
}
