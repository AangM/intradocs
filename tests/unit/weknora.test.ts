// Contract tests for the WeKnora adapter, driven by an injected fetch so the wire
// format is asserted exactly. These prove what we SEND and how we treat what comes
// back; they are not evidence that a live WeKnora agrees. See docs/WEKNORA.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readAiConfig } from '../../packages/core/src/ai-config.ts';
import {
  WeknoraClient,
  WeknoraError,
  parseChatStream,
  cleanAnswer,
} from '../../packages/core/src/weknora.ts';

const config = readAiConfig({
  AI_PROVIDER: 'weknora-local',
  AI_GENERATION: 'weknora-local',
  WEKNORA_BASE_URL: 'http://127.0.0.1:58080',
  WEKNORA_API_KEY: 'sk-local-abcdefghijklmnop',
  WEKNORA_KNOWLEDGE_BASE_ID: 'kb-intradocs-0001',
  WEKNORA_TENANT_ID: '7',
}).weknora!;

type Call = { url: string; init: RequestInit };

function recorder(respond: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return respond({ url, init });
  };
  return { calls, fetchImpl };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function header(init: RequestInit, name: string): string | null {
  return new Headers(init.headers).get(name);
}

test('every request carries the API key and the pinned tenant, and refuses redirects', async () => {
  const { calls, fetchImpl } = recorder(() => json({ data: { id: 'k-1' } }));
  await new WeknoraClient(config, fetchImpl).createManualKnowledge({ title: 't', content: 'c' });
  const call = calls[0]!;
  assert.equal(header(call.init, 'X-API-Key'), config.apiKey);
  assert.equal(header(call.init, 'X-Tenant-ID'), '7');
  // A followed redirect would hand the API key to whatever host WeKnora names.
  assert.equal(call.init.redirect, 'error');
  assert.equal(call.init.cache, 'no-store');
  assert(call.init.signal instanceof AbortSignal);
});

test('retrieval pins the knowledge base and forwards only authorised knowledge IDs', async () => {
  const { calls, fetchImpl } = recorder(() => json({ data: [] }));
  await new WeknoraClient(config, fetchImpl).hybridSearch({
    knowledgeIds: ['k-1', 'k-2'],
    queryText: 'kebijakan backup',
    matchCount: 6,
  });
  const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
  assert.deepEqual(body.knowledge_base_ids, [config.knowledgeBaseId]);
  assert.deepEqual(body.knowledge_ids, ['k-1', 'k-2']);
  assert.equal(body.match_count, 6);
  assert(calls[0]!.url.endsWith(`/api/v1/knowledge-bases/${config.knowledgeBaseId}/hybrid-search`));
});

test('an empty authorised set never reaches WeKnora at all', async () => {
  const { calls, fetchImpl } = recorder(() =>
    json({ data: [{ knowledge_id: 'x', content: 'y' }] }),
  );
  const hits = await new WeknoraClient(config, fetchImpl).hybridSearch({
    knowledgeIds: [],
    queryText: 'apa saja',
    matchCount: 6,
  });
  assert.deepEqual(hits, []);
  assert.equal(calls.length, 0, 'an unscoped query must not be issued');
});

test('chat pins agent mode, web search and the knowledge scope off the client', async () => {
  const { calls, fetchImpl } = recorder(
    () => new Response('data: {"response_type":"complete","done":true}\n\n', { status: 200 }),
  );
  await new WeknoraClient(config, fetchImpl).knowledgeChat('s-1', {
    query: 'apa kebijakan backup?',
    knowledgeIds: ['k-1'],
  });
  const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
  assert.equal(body.agent_enabled, false);
  assert.equal(body.web_search_enabled, false);
  assert.deepEqual(body.knowledge_base_ids, [config.knowledgeBaseId]);
  assert.deepEqual(body.knowledge_ids, ['k-1']);
  assert.equal(body.mcp_service_ids, undefined);
  assert.equal(body.skill_names, undefined);
});

test('the answering model is pinned in the chat body when configured, absent otherwise', async () => {
  const stream = () =>
    new Response('data: {"response_type":"complete","done":true}\n\n', { status: 200 });
  const unpinned = recorder(stream);
  await new WeknoraClient(config, unpinned.fetchImpl).knowledgeChat('s-1', {
    query: 'q',
    knowledgeIds: ['k-1'],
  });
  assert.equal(
    (JSON.parse(String(unpinned.calls[0]!.init.body)) as Record<string, unknown>).summary_model_id,
    undefined,
    'without a pin nothing is invented; WeKnora keeps its default',
  );

  const pinned = recorder(stream);
  await new WeknoraClient(
    { ...config, generationModelId: 'model-lokal-0001' },
    pinned.fetchImpl,
  ).knowledgeChat('s-1', { query: 'q', knowledgeIds: ['k-1'] });
  assert.equal(
    (JSON.parse(String(pinned.calls[0]!.init.body)) as Record<string, unknown>).summary_model_id,
    'model-lokal-0001',
    'WeKnora calls the answering model the summary model',
  );
});

test('malformed hits are dropped rather than passed on as citations', async () => {
  const { fetchImpl } = recorder(() =>
    json({
      data: [
        { knowledge_id: 'k-1', id: 'c1', content: 'isi', score: 0.5, seq: 1 },
        { knowledge_id: '', id: 'c2', content: 'isi' },
        { id: 'c3', content: 'tanpa knowledge id' },
        { knowledge_id: 'k-2', id: 'c4' },
        'bukan objek',
      ],
    }),
  );
  const hits = await new WeknoraClient(config, fetchImpl).hybridSearch({
    knowledgeIds: ['k-1'],
    queryText: 'q',
    matchCount: 6,
  });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.knowledgeId, 'k-1');
});

test('an error body is never echoed back; only the status survives', async () => {
  const secret = 'SYNTHETIC-CONFIDENTIAL-CANARY-7';
  const { fetchImpl } = recorder(() => json({ message: secret }, 403));
  await assert.rejects(
    new WeknoraClient(config, fetchImpl).createManualKnowledge({ title: 't', content: 'c' }),
    (error: unknown) => {
      assert(error instanceof WeknoraError);
      assert.equal(error.status, 403);
      assert(!error.message.includes(secret));
      return true;
    },
  );
});

test('a failure reply with success:false is rejected, not read as data', async () => {
  const { fetchImpl } = recorder(() => json({ success: false, message: 'gagal' }));
  await assert.rejects(
    new WeknoraClient(config, fetchImpl).createManualKnowledge({ title: 't', content: 'c' }),
    WeknoraError,
  );
});

test('an oversized response is refused instead of being buffered', async () => {
  const small = { ...config, maxResponseBytes: 64 };
  const { fetchImpl } = recorder(() => json({ data: 'x'.repeat(4096) }));
  await assert.rejects(
    new WeknoraClient(small, fetchImpl).createManualKnowledge({ title: 't', content: 'c' }),
    /batas ukuran/,
  );
});

test('a transport failure is reported as retryable without leaking the endpoint', async () => {
  const fetchImpl = async () => {
    throw new Error('ECONNREFUSED 127.0.0.1:58080');
  };
  await assert.rejects(
    new WeknoraClient(config, fetchImpl).hybridSearch({
      knowledgeIds: ['k-1'],
      queryText: 'q',
      matchCount: 1,
    }),
    (error: unknown) => {
      assert(error instanceof WeknoraError);
      assert.equal(error.retryable, true);
      assert(!error.message.includes('58080'));
      return true;
    },
  );
});

test('health and readiness fail closed instead of throwing', async () => {
  const down = new WeknoraClient(config, async () => {
    throw new Error('offline');
  });
  assert.equal(await down.health(), false);
  assert.equal(await down.knowledgeBaseReachable(), false);
  const wrongKb = new WeknoraClient(config, async () => json({ data: { id: 'kb-someone-else' } }));
  assert.equal(await wrongKb.knowledgeBaseReachable(), false);
});

test('deleting an already-absent record is success, not an error to retry forever', async () => {
  const { fetchImpl } = recorder(() => json({ message: 'not found' }, 404));
  await new WeknoraClient(config, fetchImpl).deleteKnowledge('k-gone');
});

// --- SSE parsing -----------------------------------------------------------

test('the answer stream is assembled from answer frames and its references', () => {
  const stream = [
    'data: {"response_type":"thinking","content":"berpikir"}',
    '',
    'data: {"response_type":"answer","content":"Kebijakan backup "}',
    '',
    'data: {"response_type":"answer","content":"diverifikasi lewat restore."}',
    '',
    'data: {"response_type":"references","knowledge_references":[{"knowledge_id":"k-1","id":"c1","content":"isi","score":0.9}]}',
    '',
    'data: {"response_type":"complete","done":true}',
    '',
  ].join('\n');
  const result = parseChatStream(stream, 4000);
  assert.equal(result.answer, 'Kebijakan backup diverifikasi lewat restore.');
  assert.equal(result.references.length, 1);
  assert.equal(result.references[0]!.knowledgeId, 'k-1');
  // "thinking" is not an answer and must not reach the user.
  assert(!result.answer.includes('berpikir'));
});

test('an error frame aborts the answer rather than returning a partial one', () => {
  const stream = [
    'data: {"response_type":"answer","content":"sebagian"}',
    '',
    'data: {"response_type":"error","content":"model gagal"}',
    '',
  ].join('\n');
  assert.throws(() => parseChatStream(stream, 4000), WeknoraError);
});

test('the answer is clamped to the configured budget', () => {
  const frames = Array.from(
    { length: 50 },
    () => 'data: {"response_type":"answer","content":"0123456789"}\n\n',
  ).join('');
  assert.equal(parseChatStream(frames, 100).answer.length, 100);
});

test('garbage frames are skipped without failing the whole stream', () => {
  const stream = [
    'data: bukan-json',
    '',
    ': komentar sse',
    '',
    'data: {"response_type":"answer","content":"tetap terbaca"}',
    '',
  ].join('\n');
  assert.equal(parseChatStream(stream, 4000).answer, 'tetap terbaca');
});

test("WeKnora's own citation markup never reaches a reader", () => {
  const raw = [
    'SLA reset password adalah **30 menit**.  ',
    '',
    '<kb doc="[IntraDocs:3000-0001] Panduan" chunk_id="266c" kb_id="ce60" />',
    '',
    '',
    '<kb doc="x"></kb>',
  ].join('\n');
  const clean = cleanAnswer(raw);
  assert.equal(clean, 'SLA reset password adalah **30 menit**.');
  assert(!/<kb/i.test(clean) && !/chunk_id|kb_id/.test(clean));
});
