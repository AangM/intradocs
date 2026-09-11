// WeKnora adapter. This is the ONLY module that speaks WeKnora's wire format.
//
// It is deliberately dumb about policy: it does not know what a scope, a grant,
// an approval state or an actor is. Everything it returns is untrusted input that
// the caller must re-validate against IntraDocs before it reaches a user. In the
// other direction it never sends an IntraDocs identity, session, role or email.
//
// Contract source: Tencent/WeKnora v0.8.0 docs/swagger.json (basePath /api/v1),
// plus internal/types/chat.go for the SSE StreamResponse shape.
import type { WeknoraConfig } from './ai-config.ts';

export class WeknoraError extends Error {
  // Written out rather than declared as constructor parameter properties: the unit
  // suite runs under Node's strip-only TypeScript, which does not support those.
  readonly status: number;
  readonly retryable: boolean;
  constructor(message: string, status: number, retryable: boolean) {
    super(message);
    this.name = 'WeknoraError';
    this.status = status;
    this.retryable = retryable;
  }
}

export interface WeknoraKnowledge {
  id: string;
  title: string;
  parseStatus: string;
}

export type WeknoraMatchType = 'vector' | 'keyword' | 'context' | 'other';

export interface WeknoraSearchHit {
  knowledgeId: string;
  chunkId: string;
  content: string;
  score: number;
  /** How WeKnora found this chunk; context chunks are neighbours, not matches. */
  matchType: WeknoraMatchType;
  seq: number;
  chunkIndex: number;
  startAt: number;
  endAt: number;
}

export interface WeknoraAnswer {
  answer: string;
  references: WeknoraSearchHit[];
}

export interface WeknoraSearchRequest {
  /** WeKnora knowledge IDs the caller has already authorised. Never empty. */
  knowledgeIds: readonly string[];
  queryText: string;
  matchCount: number;
  /** Keyword-only retrieval keeps a deployment without an embedding model usable. */
  disableVectorMatch?: boolean;
  disableKeywordsMatch?: boolean;
}

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new WeknoraError('Respons WeKnora bukan objek JSON yang dikenali.', 502, false);
  return value as Json;
}

/** WeKnora wraps most payloads in {success,data}; a few handlers answer bare. */
function unwrap(body: unknown): unknown {
  const record = asRecord(body);
  if (record.success === false) throw new WeknoraError(safeMessage(record), 502, false);
  return 'data' in record ? record.data : record;
}

function safeMessage(record: Json): string {
  const raw = typeof record.message === 'string' ? record.message : '';
  // Never echo a WeKnora body verbatim: it can carry document text or a token.
  return raw ? `WeKnora menolak permintaan (${raw.slice(0, 120)}).` : 'WeKnora menolak permintaan.';
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** WeKnora's MatchType enum: 0 embedding, 1 keywords, 2/4/5 context enrichment. */
function matchType(value: unknown): WeknoraMatchType {
  switch (value) {
    case 0:
      return 'vector';
    case 1:
      return 'keyword';
    case 2:
    case 4:
    case 5:
      return 'context';
    default:
      return 'other';
  }
}

function toHit(value: unknown): WeknoraSearchHit | null {
  if (!value || typeof value !== 'object') return null;
  const r = value as Json;
  const knowledgeId = str(r.knowledge_id);
  const content = str(r.content);
  if (!knowledgeId || !content) return null;
  return {
    knowledgeId,
    chunkId: str(r.id),
    content,
    score: num(r.score),
    matchType: matchType(r.match_type),
    seq: num(r.seq),
    chunkIndex: num(r.chunk_index),
    startAt: num(r.start_at),
    endAt: num(r.end_at),
  };
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export class WeknoraClient {
  private readonly config: WeknoraConfig;
  private readonly fetchImpl: FetchLike;
  constructor(config: WeknoraConfig, fetchImpl: FetchLike = (input, init) => fetch(input, init)) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      'X-API-Key': this.config.apiKey,
      Accept: 'application/json',
      ...extra,
    };
    if (this.config.tenantId) headers['X-Tenant-ID'] = this.config.tenantId;
    return headers;
  }

  private async send(
    method: string,
    path: string,
    options: { body?: unknown; timeoutMs?: number; accept?: string } = {},
  ): Promise<Response> {
    const timeout = options.timeoutMs ?? this.config.requestTimeoutMs;
    const init: RequestInit = {
      method,
      // A redirect would let a compromised WeKnora send our API key elsewhere.
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(timeout),
      headers: this.headers(
        options.body === undefined
          ? options.accept
            ? { Accept: options.accept }
            : undefined
          : {
              'Content-Type': 'application/json',
              ...(options.accept ? { Accept: options.accept } : {}),
            },
      ),
    };
    if (options.body !== undefined) init.body = JSON.stringify(options.body);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.baseUrl}${path}`, init);
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      throw new WeknoraError(
        timedOut ? 'WeKnora tidak menjawab sebelum batas waktu.' : 'WeKnora tidak dapat dihubungi.',
        504,
        true,
      );
    }
    if (!response.ok) {
      const retryable = response.status >= 500 || response.status === 429;
      // Status only. A WeKnora error body is untrusted and may contain content.
      throw new WeknoraError(
        `WeKnora membalas status ${response.status}.`,
        response.status,
        retryable,
      );
    }
    return response;
  }

  private async readJson(response: Response): Promise<unknown> {
    const text = await this.readBounded(response);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new WeknoraError('Respons WeKnora bukan JSON.', 502, false);
    }
  }

  /** Reads at most maxResponseBytes so a runaway response cannot exhaust memory. */
  private async readBounded(response: Response): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader) return '';
    const decoder = new TextDecoder();
    let out = '';
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > this.config.maxResponseBytes) {
          await reader.cancel();
          throw new WeknoraError('Respons WeKnora melewati batas ukuran.', 502, false);
        }
        out += decoder.decode(value, { stream: true });
      }
    } finally {
      reader.releaseLock?.();
    }
    return out + decoder.decode();
  }

  private async json(
    method: string,
    path: string,
    options: { body?: unknown; timeoutMs?: number } = {},
  ): Promise<unknown> {
    return unwrap(await this.readJson(await this.send(method, path, options)));
  }

  /** Liveness only: /health sits outside /api/v1 and needs no credential. */
  async health(): Promise<boolean> {
    try {
      const response = await this.send('GET', '/health', { timeoutMs: 5000 });
      await this.readBounded(response);
      return true;
    } catch {
      return false;
    }
  }

  /** Readiness: proves the configured key can actually reach the pinned KB. */
  async knowledgeBaseReachable(): Promise<boolean> {
    try {
      const data = asRecord(
        await this.json(
          'GET',
          `/api/v1/knowledge-bases/${encodeURIComponent(this.config.knowledgeBaseId)}`,
        ),
      );
      return str(data.id) === this.config.knowledgeBaseId;
    } catch {
      return false;
    }
  }

  /** The knowledge base record, as WeKnora stores it. Defaults to the configured base. */
  async knowledgeBase(id = this.config.knowledgeBaseId): Promise<Record<string, unknown>> {
    return asRecord(await this.json('GET', `/api/v1/knowledge-bases/${encodeURIComponent(id)}`));
  }

  /**
   * Creates a knowledge base with ingest-time features chosen up front. `summary_model_id`
   * cannot be changed afterwards in this WeKnora version, which is the reason this exists
   * separately from setup: an experimental base is created whole rather than edited.
   */
  async createKnowledgeBase(input: {
    name: string;
    description: string;
    embeddingModelId: string;
    summaryModelId: string;
    wiki: boolean;
    questionGeneration: { enabled: boolean; questionCount: number; modelId: string };
    autoTag: { enabled: boolean; modelId: string };
  }): Promise<string> {
    const data = asRecord(
      await this.json('POST', '/api/v1/knowledge-bases', {
        body: {
          name: input.name,
          description: input.description,
          type: 'document',
          embedding_model_id: input.embeddingModelId,
          summary_model_id: input.summaryModelId,
          indexing_strategy: {
            vector_enabled: true,
            keyword_enabled: true,
            graph_enabled: false,
            wiki_enabled: input.wiki,
          },
          chunking_config: { chunk_size: 400, chunk_overlap: 40, enable_parent_child: false },
          question_generation_config: {
            enabled: input.questionGeneration.enabled,
            question_count: input.questionGeneration.questionCount,
            model_id: input.questionGeneration.modelId,
          },
          auto_tag_config: {
            enabled: input.autoTag.enabled,
            model_id: input.autoTag.modelId,
            max_tags: 5,
            skip_if_tagged: true,
          },
        },
      }),
    );
    const id = str(data.id);
    if (!id) throw new WeknoraError('WeKnora tidak mengembalikan ID knowledge base.', 502, false);
    return id;
  }

  async findKnowledgeByKeyword(keyword: string): Promise<WeknoraKnowledge[]> {
    const query = new URLSearchParams({ keyword, page: '1', page_size: '20' });
    const data = await this.json(
      'GET',
      `/api/v1/knowledge-bases/${encodeURIComponent(this.config.knowledgeBaseId)}/knowledge?${query}`,
    );
    const rows = Array.isArray(data)
      ? data
      : Array.isArray(asRecord(data).data)
        ? (asRecord(data).data as unknown[])
        : [];
    const out: WeknoraKnowledge[] = [];
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const r = row as Json;
      const id = str(r.id);
      if (id) out.push({ id, title: str(r.title), parseStatus: str(r.parse_status, 'unknown') });
    }
    return out;
  }

  /**
   * Every knowledge record in the pinned knowledge base, paged.
   *
   * Used only by the orphan sweep. A record can outlive its IntraDocs row when the
   * version is deleted outright: the cascade drops the mapping before the exporter can
   * issue the matching delete, so the sweep finds it by title instead.
   */
  async listKnowledge(maxRecords = 1000): Promise<WeknoraKnowledge[]> {
    const out: WeknoraKnowledge[] = [];
    const pageSize = 100;
    for (let page = 1; out.length < maxRecords; page += 1) {
      const query = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
      const data = await this.json(
        'GET',
        `/api/v1/knowledge-bases/${encodeURIComponent(this.config.knowledgeBaseId)}/knowledge?${query}`,
      );
      const rows = Array.isArray(data)
        ? data
        : Array.isArray(asRecord(data).data)
          ? (asRecord(data).data as unknown[])
          : [];
      if (rows.length === 0) break;
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        const r = row as Json;
        const id = str(r.id);
        if (id) out.push({ id, title: str(r.title), parseStatus: str(r.parse_status, 'unknown') });
      }
      if (rows.length < pageSize) break;
    }
    return out;
  }

  async createManualKnowledge(input: { title: string; content: string }): Promise<string> {
    const data = asRecord(
      await this.json(
        'POST',
        `/api/v1/knowledge-bases/${encodeURIComponent(this.config.knowledgeBaseId)}/knowledge/manual`,
        { body: { title: input.title, content: input.content } },
      ),
    );
    const id = str(data.id);
    if (!id) throw new WeknoraError('WeKnora tidak mengembalikan knowledge ID.', 502, false);
    return id;
  }

  async updateManualKnowledge(
    knowledgeId: string,
    input: { title: string; content: string },
  ): Promise<void> {
    await this.json('PUT', `/api/v1/knowledge/manual/${encodeURIComponent(knowledgeId)}`, {
      body: { title: input.title, content: input.content },
    });
  }

  /**
   * Manual knowledge is created as a draft with parsing disabled, so it is stored but
   * never chunked, embedded or searchable until this runs. Without it an export looks
   * successful while retrieval silently returns nothing.
   */
  async reparseKnowledge(knowledgeIds: readonly string[]): Promise<void> {
    if (knowledgeIds.length === 0) return;
    await this.json('POST', '/api/v1/knowledge/batch-reparse', {
      body: { ids: [...knowledgeIds], kb_id: this.config.knowledgeBaseId },
    });
  }

  /**
   * Registers a model WeKnora may use. The provider key travels in this one request and
   * is stored by WeKnora; it is never logged here, never echoed back, and never returned
   * to a caller -- only the resulting model ID comes back.
   */
  async registerModel(input: {
    name: string;
    displayName: string;
    type: 'KnowledgeQA' | 'Embedding' | 'Rerank';
    source: string;
    parameters: Record<string, unknown>;
  }): Promise<string> {
    const data = asRecord(
      await this.json('POST', '/api/v1/models', {
        body: {
          name: input.name,
          display_name: input.displayName,
          type: input.type,
          source: input.source,
          parameters: input.parameters,
        },
      }),
    );
    const id = str(data.id);
    if (!id) throw new WeknoraError('WeKnora tidak mengembalikan ID model.', 502, false);
    return id;
  }

  /**
   * Tags WeKnora's auto-tagger attached to one knowledge record.
   *
   * These are suggestions produced by a language model reading document text, so they
   * are returned as raw strings and nothing more. The caller decides what they mean:
   * IntraDocs only keeps the ones that already exist in its own label vocabulary, which
   * is what stops a sentence inside a document from inventing a label.
   */
  async knowledgeTags(knowledgeId: string): Promise<string[]> {
    return (await this.knowledgeState(knowledgeId)).tags;
  }

  /** Parse state and tags of one record; what an operator polls after a reparse. */
  async knowledgeState(
    knowledgeId: string,
  ): Promise<{ parseStatus: string; updatedAt: number; tags: string[] }> {
    const data = asRecord(
      await this.json('GET', `/api/v1/knowledge/${encodeURIComponent(knowledgeId)}`),
    );
    const updated = Date.parse(str(data.updated_at));
    const tags = Array.isArray(data.tags) ? data.tags : [];
    const names: string[] = [];
    for (const tag of tags) {
      if (!tag || typeof tag !== 'object') continue;
      const name = str((tag as Json).name).trim();
      // Bounded: a tag is a label, and a label that long is not a label.
      if (name && name.length <= 60 && !names.includes(name)) names.push(name);
    }
    return {
      parseStatus: str(data.parse_status),
      updatedAt: Number.isFinite(updated) ? updated : 0,
      tags: names.slice(0, 10),
    };
  }

  /** Registered models, without their parameters: a provider key lives there. */
  async listModels(): Promise<Array<{ id: string; name: string; type: string; source: string }>> {
    const data = await this.json('GET', '/api/v1/models');
    const items = Array.isArray(data) ? data : [];
    const out: Array<{ id: string; name: string; type: string; source: string }> = [];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const r = item as Json;
      const id = str(r.id);
      if (id) out.push({ id, name: str(r.name), type: str(r.type), source: str(r.source) });
    }
    return out;
  }

  /** Tag vocabulary of the knowledge base; the pool the auto-tagger may choose from. */
  async listTags(): Promise<Array<{ id: string; name: string }>> {
    const data = asRecord(
      await this.json(
        'GET',
        `/api/v1/knowledge-bases/${encodeURIComponent(this.config.knowledgeBaseId)}/tags?page_size=200`,
      ),
    );
    const items = Array.isArray(data.data) ? data.data : [];
    const tags: Array<{ id: string; name: string }> = [];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const id = str((item as Json).id);
      const name = str((item as Json).name).trim();
      if (id && name) tags.push({ id, name });
    }
    return tags;
  }

  /**
   * Detaches every tag from the given records, leaving the tag pool itself alone. WeKnora
   * refuses to delete a tag that is still referenced, so this is how a run starts clean:
   * `updates` is a map of knowledge id to the exact tag ids it should carry.
   */
  async clearKnowledgeTags(knowledgeIds: readonly string[]): Promise<void> {
    if (knowledgeIds.length === 0) return;
    await this.json('PUT', '/api/v1/knowledge/tags', {
      body: {
        kb_id: this.config.knowledgeBaseId,
        updates: Object.fromEntries(knowledgeIds.map((id) => [id, []])),
      },
    });
  }

  async createTag(name: string): Promise<void> {
    await this.json(
      'POST',
      `/api/v1/knowledge-bases/${encodeURIComponent(this.config.knowledgeBaseId)}/tags`,
      { body: { name } },
    );
  }

  /**
   * Turns the auto-tagger on or off for the knowledge base. WeKnora requires the base's
   * name on every update and reads the tagging block from `config`, so the current name
   * is fetched first rather than guessed.
   */
  async setAutoTag(config: {
    enabled: boolean;
    modelId: string;
    maxTags: number;
    skipIfTagged: boolean;
  }): Promise<void> {
    const kbRoute = `/api/v1/knowledge-bases/${encodeURIComponent(this.config.knowledgeBaseId)}`;
    const current = asRecord(await this.json('GET', kbRoute));
    await this.json('PUT', kbRoute, {
      body: {
        name: str(current.name),
        description: str(current.description),
        config: {
          auto_tag_config: {
            enabled: config.enabled,
            model_id: config.modelId,
            max_tags: config.maxTags,
            skip_if_tagged: config.skipIfTagged,
          },
        },
      },
    });
  }

  /**
   * The agent IntraDocs chats through. Without an agent id WeKnora answers with its
   * builtin "quick-answer" agent, whose stored config has web search, query rewriting,
   * five turns of history and a free-model fallback switched ON; IntraDocs has been
   * switching those off per request. This pins them off in the configuration itself, and
   * is also the only place this WeKnora version lets a rerank model or a threshold be set.
   * Idempotent: found by name and updated, or created.
   */
  async ensureAgent(spec: { name: string; config: Record<string, unknown> }): Promise<string> {
    const listed = await this.json('GET', '/api/v1/agents');
    const items = Array.isArray(listed) ? listed : [];
    const existing = items.find(
      (a) => a && typeof a === 'object' && str((a as Json).name) === spec.name,
    ) as Json | undefined;
    const body = {
      name: spec.name,
      description: 'Agen IntraDocs: RAG satu giliran, tanpa web, tanpa memori, tanpa alat.',
      config: spec.config,
    };
    if (existing && str(existing.id)) {
      await this.json('PUT', `/api/v1/agents/${encodeURIComponent(str(existing.id))}`, { body });
      return str(existing.id);
    }
    const created = asRecord(await this.json('POST', '/api/v1/agents', { body }));
    const id = str(created.id);
    if (!id) throw new WeknoraError('WeKnora tidak mengembalikan ID agen.', 502, false);
    return id;
  }

  /** Stored config of one agent, for verification; prompts stripped to keep output small. */
  async agentConfig(agentId: string): Promise<Json> {
    const data = asRecord(await this.json('GET', `/api/v1/agents/${encodeURIComponent(agentId)}`));
    const config = data.config && typeof data.config === 'object' ? (data.config as Json) : {};
    const out: Json = {};
    for (const [k, v] of Object.entries(config)) if (!/prompt|template/.test(k)) out[k] = v;
    return out;
  }

  async deleteKnowledge(knowledgeId: string): Promise<void> {
    try {
      await this.json('DELETE', `/api/v1/knowledge/${encodeURIComponent(knowledgeId)}`);
    } catch (error) {
      // Already gone is the state we wanted; anything else must surface.
      if (error instanceof WeknoraError && error.status === 404) return;
      throw error;
    }
  }

  /**
   * Retrieval. `knowledgeIds` is the authorisation boundary WeKnora enforces on our
   * behalf; the caller still re-validates every hit, because a filter we send is not
   * evidence about what came back.
   */
  async hybridSearch(request: WeknoraSearchRequest): Promise<WeknoraSearchHit[]> {
    if (request.knowledgeIds.length === 0) return [];
    const data = await this.json(
      'POST',
      `/api/v1/knowledge-bases/${encodeURIComponent(this.config.knowledgeBaseId)}/hybrid-search`,
      {
        timeoutMs: this.config.searchTimeoutMs,
        body: {
          query_text: request.queryText,
          knowledge_base_ids: [this.config.knowledgeBaseId],
          knowledge_ids: [...request.knowledgeIds],
          match_count: request.matchCount,
          ...(request.disableVectorMatch ? { disable_vector_match: true } : {}),
          ...(request.disableKeywordsMatch ? { disable_keywords_match: true } : {}),
        },
      },
    );
    const rows = Array.isArray(data) ? data : [];
    const hits: WeknoraSearchHit[] = [];
    for (const row of rows) {
      const hit = toHit(row);
      if (hit) hits.push(hit);
    }
    return hits;
  }

  async createSession(title: string): Promise<string> {
    const data = asRecord(await this.json('POST', '/api/v1/sessions', { body: { title } }));
    const id = str(data.id);
    if (!id) throw new WeknoraError('WeKnora tidak mengembalikan session ID.', 502, false);
    return id;
  }

  async deleteSession(sessionId: string): Promise<void> {
    try {
      await this.json('DELETE', `/api/v1/sessions/${encodeURIComponent(sessionId)}`);
    } catch {
      // Best effort. A leftover ephemeral session is reported by the caller's audit
      // trail; failing the user's request over cleanup would be worse.
    }
  }

  /**
   * Grounded generation over an ephemeral session. Agent mode, web search and MCP are
   * pinned off here rather than left to WeKnora defaults, and the knowledge scope is
   * the caller's authorised set — the client never chooses either.
   */
  async knowledgeChat(
    sessionId: string,
    request: { query: string; knowledgeIds: readonly string[] },
  ): Promise<WeknoraAnswer> {
    const response = await this.send(
      'POST',
      `/api/v1/knowledge-chat/${encodeURIComponent(sessionId)}`,
      {
        timeoutMs: this.config.chatTimeoutMs,
        accept: 'text/event-stream',
        body: {
          query: request.query,
          knowledge_base_ids: [this.config.knowledgeBaseId],
          knowledge_ids: [...request.knowledgeIds],
          agent_enabled: false,
          web_search_enabled: false,
          disable_title: true,
          channel: 'api',
          // WeKnora calls the answering model the "summary model". Pinned here so the
          // tenant default cannot decide which model -- or which network -- answers.
          ...(this.config.generationModelId
            ? { summary_model_id: this.config.generationModelId }
            : {}),
          // The pinned agent carries web search, rewriting, history, tools and the
          // free-model fallback switched off in its own configuration (see ensureAgent).
          ...(this.config.agentId ? { agent_id: this.config.agentId } : {}),
        },
      },
    );
    return parseChatStream(await this.readBounded(response), this.config.maxAnswerChars);
  }
}

/**
 * WeKnora streams `StreamResponse` frames as SSE. We buffer the whole stream and
 * validate it before anything reaches a user, per the M4 rule that no unchecked
 * token is displayed.
 */
export function parseChatStream(raw: string, maxAnswerChars: number): WeknoraAnswer {
  let answer = '';
  const references: WeknoraSearchHit[] = [];
  const seen = new Set<string>();
  for (const block of raw.split(/\r?\n\r?\n/)) {
    const payload = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('');
    if (!payload || payload === '[DONE]') continue;
    let frame: Json;
    try {
      frame = asRecord(JSON.parse(payload));
    } catch {
      continue;
    }
    const type = str(frame.response_type);
    if (type === 'error')
      throw new WeknoraError('WeKnora melaporkan kegagalan generasi.', 502, false);
    if (type === 'answer' && answer.length < maxAnswerChars) answer += str(frame.content);
    if (Array.isArray(frame.knowledge_references))
      for (const row of frame.knowledge_references) {
        const hit = toHit(row);
        if (hit && !seen.has(hit.chunkId + hit.knowledgeId)) {
          seen.add(hit.chunkId + hit.knowledgeId);
          references.push(hit);
        }
      }
  }
  return { answer: answer.slice(0, maxAnswerChars), references };
}
