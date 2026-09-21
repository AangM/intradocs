// Translates WeKnora's rerank call into text-embeddings-inference's and back.
//
// WeKnora's generic reranker posts {model, query, documents} to `${base_url}/rerank` and
// reads {results: [{index, relevance_score}]} (Jina/Cohere shape). TEI's /rerank wants
// {query, texts} and answers [{index, score}]. Neither side is configurable, so this sits
// between them on the compose network: no dependencies, no state, one upstream fixed by
// RERANK_UPSTREAM, and nothing published to the host. Runs as `weknora-rerank-shim` in
// compose.yaml (profile weknora-rerank); see docs/WEKNORA.md §17.
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const upstream = (process.env.RERANK_UPSTREAM ?? 'http://weknora-reranker:80').replace(/\/+$/, '');
const port = Number(process.env.PORT ?? 80);
// WeKnora sends at most its retrieval top-k; TEI's --max-client-batch-size is 64.
const MAX_DOCUMENTS = 64;
const MAX_BODY_BYTES = 1_000_000;
const UPSTREAM_TIMEOUT_MS = 60_000;
// Chunk text is corpus content; it is only ever logged when asked for explicitly.
const debug = process.env.RERANK_SHIM_DEBUG === '1';
const debugChars = Number(process.env.RERANK_SHIM_DEBUG_CHARS ?? 120);

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * WeKnora appends each chunk's generated questions ("q1; q2") as the final paragraph of
 * every passage it sends (chat_pipeline/rerank.go, getEnrichedPassage). For a
 * cross-encoder that is noise, not signal: the same chunk scored 0.32 bare and 0.08-0.15
 * with an unrelated English question attached, and which questions ride along depends on
 * the retrieval path, so the score moved across the threshold from one run to the next.
 * A final paragraph made only of questions is dropped before scoring. WeKnora gets its own
 * indexes back either way; what the model reads and what is cited never pass through here.
 */
export function stripQuestionTail(text) {
  const at = text.lastIndexOf('\n\n');
  if (at < 0) return text;
  const tail = text.slice(at + 2).trim();
  const head = text.slice(0, at).trim();
  if (!tail || !head) return text;
  const questions = tail
    .split(/;\s*/)
    .map((q) => q.trim())
    .filter(Boolean);
  // One sentence each, ending in '?': a real paragraph that merely ends with a question
  // has a sentence boundary before it and is kept.
  const isQuestion = (q) => q.endsWith('?') && !/[.!?]\s+\S/.test(q.slice(0, -1));
  return questions.every(isQuestion) ? head : text;
}

/**
 * WeKnora indexes the summary it generated at ingest as a chunk of its own, headed
 * "# Summary". A summary is a small model's paraphrase, and it paraphrases wrong: the
 * VPN runbook's "Masuk menggunakan akun uji dan MFA" became "verifikasi dua faktor (MFA)
 * jika diperlukan", the summary chunk outranked the real text, and the answering model
 * concluded MFA was optional. The summary stays useful as an editor's draft (§17); it
 * is never evidence. Such a passage is scored 0 here so the threshold drops it, and the
 * reranker sees only the document's own words.
 */
export function isGeneratedSummary(text) {
  // The chunk is stored as "# Summary\n..."; the passage WeKnora hands the reranker has
  // the heading marker stripped ("Summary\n..."), so the marker is optional here.
  return /^\s*(?:#+\s*)?summary\s*\n/i.test(text);
}

/** WeKnora's request, as TEI wants it. Summary chunks are sent as empty texts. */
export function toTeiBody(query, documents) {
  return {
    query,
    texts: documents.map((d) => (isGeneratedSummary(d) ? '' : stripQuestionTail(d))),
    // truncate: inputs longer than TEI's window are cut, never rejected.
    raw_scores: false,
    truncate: true,
  };
}

/** TEI's reply, as WeKnora reads it: indexes into the ORIGINAL documents, best first. */
export function toWeknoraResults(scored, documents) {
  if (!Array.isArray(scored)) return null;
  return scored
    .filter((r) => Number.isInteger(r?.index) && r.index >= 0 && r.index < documents.length)
    .map((r) => ({
      index: r.index,
      relevance_score:
        isGeneratedSummary(documents[r.index]) || typeof r.score !== 'number' ? 0 : r.score,
      document: { text: documents[r.index] },
    }))
    .sort((a, b) => b.relevance_score - a.relevance_score);
}

async function rerank(req, res) {
  let parsed;
  try {
    parsed = JSON.parse(await readBody(req));
  } catch (error) {
    send(res, error?.status === 413 ? 413 : 400, { error: 'invalid JSON body' });
    return;
  }
  const query = typeof parsed?.query === 'string' ? parsed.query : '';
  const documents = Array.isArray(parsed?.documents) ? parsed.documents : null;
  if (!query || !documents || !documents.every((d) => typeof d === 'string')) {
    send(res, 422, { error: 'expected {query: string, documents: string[]}' });
    return;
  }
  if (documents.length > MAX_DOCUMENTS) {
    send(res, 413, { error: `at most ${MAX_DOCUMENTS} documents per request` });
    return;
  }
  if (documents.length === 0) {
    send(res, 200, {
      id: 'shim',
      model: String(parsed.model ?? ''),
      usage: { total_tokens: 0 },
      results: [],
    });
    return;
  }
  let scored;
  try {
    const response = await fetch(`${upstream}/rerank`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(toTeiBody(query, documents)),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!response.ok) {
      send(res, 502, { error: `reranker answered ${response.status}` });
      return;
    }
    scored = await response.json();
  } catch {
    send(res, 502, { error: 'reranker unreachable' });
    return;
  }
  const results = toWeknoraResults(scored, documents);
  if (!results) {
    send(res, 502, { error: 'unexpected reranker reply' });
    return;
  }
  if (debug)
    console.log(
      JSON.stringify({
        query,
        results: results.map((r) => ({
          index: r.index,
          score: Number(r.relevance_score.toFixed(4)),
          text: r.document.text.slice(0, debugChars),
        })),
      }),
    );
  send(res, 200, {
    id: 'shim',
    model: String(parsed.model ?? ''),
    usage: { total_tokens: 0 },
    results,
  });
}

async function health(res) {
  try {
    const response = await fetch(`${upstream}/health`, { signal: AbortSignal.timeout(5_000) });
    send(res, response.ok ? 200 : 503, { upstream: response.status });
  } catch {
    send(res, 503, { upstream: 'unreachable' });
  }
}

const server = createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  if (req.method === 'POST' && path === '/rerank') {
    rerank(req, res).catch(() => send(res, 500, { error: 'shim failure' }));
    return;
  }
  if (req.method === 'GET' && path === '/health') {
    health(res);
    return;
  }
  send(res, 404, { error: 'not found' });
});

// Serve only when run directly; tests import the functions above.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  server.listen(port, '0.0.0.0', () => {
    console.log(`rerank shim on :${port} -> ${upstream}`);
  });
  for (const signal of ['SIGTERM', 'SIGINT'])
    process.on(signal, () => server.close(() => process.exit(0)));
}
