// A local HTTP server that speaks WeKnora's documented contract (Tencent/WeKnora
// v0.8.0, docs/swagger.json, basePath /api/v1).
//
// This is a TEST DOUBLE, not evidence that a real WeKnora behaves this way. It exists
// so the export pipeline's idempotency, crash recovery and revocation behaviour can be
// asserted deterministically — including failure modes a healthy server would never
// produce on demand. Gates that require the real service stay BLOCKED until it runs.
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';

export interface StubRecord {
  id: string;
  title: string;
  content: string;
}

export interface WeknoraStub {
  port: number;
  baseUrl: string;
  apiKey: string;
  knowledgeBaseId: string;
  records: Map<string, StubRecord>;
  /** Requests seen, for asserting what we sent. */
  requests: Array<{ method: string; path: string; apiKey: string | null }>;
  /** Makes the next matching call fail, to simulate a crash mid-export. */
  failNext: (method: string, pathFragment: string, status?: number) => void;
  /** Makes hybrid-search also return a hit the caller never authorised. */
  injectRogueHit: (knowledgeId: string, content: string) => void;
  /** Drops a record behind our back, as an out-of-band deletion would. */
  close: () => Promise<void>;
}

function send(response: import('node:http').ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(payload);
}

export async function startWeknoraStub(): Promise<WeknoraStub> {
  const apiKey = `sk-stub-${randomUUID().replace(/-/g, '')}`;
  const knowledgeBaseId = 'kb-stub-000000001';
  const records = new Map<string, StubRecord>();
  const requests: WeknoraStub['requests'] = [];
  const failures: Array<{ method: string; fragment: string; status: number }> = [];
  let rogue: { knowledgeId: string; content: string } | null = null;

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const key = request.headers['x-api-key'];
    requests.push({
      method: request.method ?? 'GET',
      path,
      apiKey: typeof key === 'string' ? key : null,
    });

    const failureAt = failures.findIndex(
      (f) => f.method === request.method && path.includes(f.fragment),
    );
    if (failureAt >= 0) {
      const [failure] = failures.splice(failureAt, 1);
      send(response, failure!.status, { success: false, message: 'kegagalan yang disuntikkan' });
      return;
    }

    if (path === '/health') {
      send(response, 200, { status: 'ok' });
      return;
    }
    // Everything under /api/v1 needs the key: an unauthenticated caller must not
    // be able to read or change the index.
    if (key !== apiKey) {
      send(response, 401, { success: false, message: 'unauthorized' });
      return;
    }

    let raw = '';
    request.on('data', (chunk) => {
      raw += chunk;
    });
    request.on('end', () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const kbPrefix = `/api/v1/knowledge-bases/${knowledgeBaseId}`;

      if (request.method === 'GET' && path === kbPrefix) {
        send(response, 200, { success: true, data: { id: knowledgeBaseId } });
        return;
      }
      if (request.method === 'GET' && path === `${kbPrefix}/knowledge`) {
        const keyword = url.searchParams.get('keyword') ?? '';
        const matches = [...records.values()].filter(
          (record) =>
            !keyword || record.title.includes(keyword) || record.content.includes(keyword),
        );
        send(response, 200, {
          success: true,
          data: matches.map((r) => ({ id: r.id, title: r.title, parse_status: 'completed' })),
        });
        return;
      }
      if (request.method === 'POST' && path === `${kbPrefix}/knowledge/manual`) {
        const id = `wk-${randomUUID()}`;
        records.set(id, {
          id,
          title: String(body.title ?? ''),
          content: String(body.content ?? ''),
        });
        send(response, 200, { success: true, data: { id } });
        return;
      }
      if (request.method === 'PUT' && path.startsWith('/api/v1/knowledge/manual/')) {
        const id = decodeURIComponent(path.slice('/api/v1/knowledge/manual/'.length));
        const record = records.get(id);
        if (!record) {
          send(response, 404, { success: false, message: 'not found' });
          return;
        }
        record.title = String(body.title ?? record.title);
        record.content = String(body.content ?? record.content);
        send(response, 200, { success: true, data: { id } });
        return;
      }
      if (request.method === 'DELETE' && path.startsWith('/api/v1/knowledge/')) {
        const id = decodeURIComponent(path.slice('/api/v1/knowledge/'.length));
        if (!records.delete(id)) {
          send(response, 404, { success: false, message: 'not found' });
          return;
        }
        send(response, 200, { success: true, data: { task_id: randomUUID() } });
        return;
      }
      if (request.method === 'POST' && path === `${kbPrefix}/hybrid-search`) {
        const scope = new Set((body.knowledge_ids as string[] | undefined) ?? []);
        const query = String(body.query_text ?? '').toLowerCase();
        const terms = query.split(/\s+/u).filter((term) => term.length > 3);
        const hits = [...records.values()]
          .filter((record) => scope.has(record.id))
          .filter((record) => terms.some((term) => record.content.toLowerCase().includes(term)))
          .slice(0, Number(body.match_count ?? 6))
          .map((record, index) => ({
            id: `chunk-${record.id}-${index}`,
            knowledge_id: record.id,
            content: record.content.slice(0, 600),
            score: 1 - index * 0.01,
            seq: index,
            chunk_index: index,
            start_at: 0,
            end_at: 600,
          }));
        if (rogue)
          hits.push({
            id: `chunk-rogue`,
            knowledge_id: rogue.knowledgeId,
            content: rogue.content,
            score: 0.99,
            seq: 99,
            chunk_index: 99,
            start_at: 0,
            end_at: rogue.content.length,
          });
        send(response, 200, { success: true, data: hits });
        return;
      }
      send(response, 404, { success: false, message: 'route tidak dikenal pada stub' });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    apiKey,
    knowledgeBaseId,
    records,
    requests,
    failNext: (method, fragment, status = 500) => failures.push({ method, fragment, status }),
    injectRogueHit: (knowledgeId, content) => {
      rogue = { knowledgeId, content };
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
