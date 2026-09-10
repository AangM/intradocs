// Configuration guard for the M4 RAG boundary.
//
// Two switches, both fail-closed and both server-side only:
//   AI_PROVIDER   off | weknora-local   -> may query a loopback WeKnora for candidates
//   AI_GENERATION off | weknora-local   -> may additionally ask WeKnora to compose an answer
//
// Generation without retrieval is rejected: an answer that is not grounded in a
// validated IntraDocs citation is not a product we ship. Nothing here enables a
// cloud provider, billing, web search, MCP, or an agent sandbox; those stay out of
// the accepted value set entirely rather than behind a default-off flag.
import { ConfigurationError } from './config.ts';

export type AiMode = 'off' | 'weknora-local';
const MODES: readonly AiMode[] = ['off', 'weknora-local'];

export interface WeknoraLimits {
  /** Whole-request deadline for one WeKnora HTTP call. */
  requestTimeoutMs: number;
  /** Deadline for one retrieval round trip. */
  searchTimeoutMs: number;
  /** Deadline for one generation round trip. */
  chatTimeoutMs: number;
  /** Maximum candidate chunks asked of WeKnora, before validation drops any. */
  maxCandidates: number;
  /** Upper bound on how many indexed versions may be named in one scope filter. */
  maxScopeDocuments: number;
  /** Maximum bytes accepted from a WeKnora response body. */
  maxResponseBytes: number;
  /** Documents exported per pass; keeps one sync bounded and restartable. */
  exportBatchSize: number;
  /** Bounded retry budget per version before an entry is parked as failed. */
  exportMaxAttempts: number;
  /** Longest question accepted from a client. */
  maxQuestionChars: number;
  /** Longest snippet returned to a client per citation. */
  maxSnippetChars: number;
  /** Longest generated answer accepted from WeKnora. */
  maxAnswerChars: number;
}

export interface WeknoraConfig extends WeknoraLimits {
  baseUrl: string;
  /** Never serialise this. Use describeAiConfig() for anything user-visible. */
  apiKey: string;
  knowledgeBaseId: string;
  tenantId: string | null;
}

export interface AiConfig {
  retrieval: AiMode;
  generation: AiMode;
  weknora: WeknoraConfig | null;
}

const DEFAULT_LIMITS: WeknoraLimits = {
  requestTimeoutMs: 15_000,
  searchTimeoutMs: 15_000,
  chatTimeoutMs: 60_000,
  maxCandidates: 6,
  maxScopeDocuments: 200,
  maxResponseBytes: 2 * 1024 * 1024,
  exportBatchSize: 25,
  exportMaxAttempts: 5,
  maxQuestionChars: 2000,
  maxSnippetChars: 700,
  maxAnswerChars: 4000,
};

// Ceilings, not suggestions: an operator may tune a budget down but may not raise
// it past the point where one request could monopolise the local machine.
const CEILINGS: WeknoraLimits = {
  requestTimeoutMs: 60_000,
  searchTimeoutMs: 60_000,
  chatTimeoutMs: 180_000,
  maxCandidates: 20,
  maxScopeDocuments: 500,
  maxResponseBytes: 8 * 1024 * 1024,
  exportBatchSize: 100,
  exportMaxAttempts: 10,
  maxQuestionChars: 4000,
  maxSnippetChars: 2000,
  maxAnswerChars: 8000,
};

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function readMode(env: Record<string, string | undefined>, key: string): AiMode {
  const raw = env[key] ?? 'off';
  if (!(MODES as readonly string[]).includes(raw))
    throw new ConfigurationError(
      `${key} hanya menerima off atau weknora-local. Provider cloud tidak diimplementasikan.`,
    );
  return raw as AiMode;
}

function readLimit(
  env: Record<string, string | undefined>,
  key: string,
  field: keyof WeknoraLimits,
): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return DEFAULT_LIMITS[field];
  if (!/^\d{1,9}$/.test(raw)) throw new ConfigurationError(`${key} harus bilangan bulat positif.`);
  const value = Number(raw);
  if (value < 1) throw new ConfigurationError(`${key} harus lebih besar dari nol.`);
  if (value > CEILINGS[field])
    throw new ConfigurationError(`${key} melewati batas resource M4 (${CEILINGS[field]}).`);
  return value;
}

export function assertLoopbackHttpOrigin(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigurationError(`${label} bukan URL yang valid.`);
  }
  if (
    url.protocol !== 'http:' ||
    !LOOPBACK_HOSTS.has(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new ConfigurationError(
      `${label} harus origin http loopback tanpa path/credential. M4 tidak memanggil host jaringan.`,
    );
  return url.origin;
}

export function readAiConfig(env: Record<string, string | undefined>): AiConfig {
  const retrieval = readMode(env, 'AI_PROVIDER');
  const generation = readMode(env, 'AI_GENERATION');
  if (generation !== 'off' && retrieval === 'off')
    throw new ConfigurationError(
      'AI_GENERATION membutuhkan AI_PROVIDER=weknora-local; jawaban tanpa retrieval tervalidasi ditolak.',
    );
  if (retrieval === 'off') return { retrieval, generation: 'off', weknora: null };

  const baseUrl = assertLoopbackHttpOrigin(env.WEKNORA_BASE_URL ?? '', 'WEKNORA_BASE_URL');
  const apiKey = env.WEKNORA_API_KEY ?? '';
  if (!/^[\x21-\x7e]{16,512}$/.test(apiKey))
    throw new ConfigurationError(
      'WEKNORA_API_KEY belum diisi token server-side yang wajar (16–512 karakter tercetak).',
    );
  const knowledgeBaseId = env.WEKNORA_KNOWLEDGE_BASE_ID ?? '';
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(knowledgeBaseId))
    throw new ConfigurationError(
      'WEKNORA_KNOWLEDGE_BASE_ID wajib diisi satu knowledge base yang dipilih server.',
    );
  const tenantRaw = env.WEKNORA_TENANT_ID ?? '';
  if (tenantRaw && !/^\d{1,19}$/.test(tenantRaw))
    throw new ConfigurationError('WEKNORA_TENANT_ID harus numerik bila diisi.');

  return {
    retrieval,
    generation,
    weknora: {
      baseUrl,
      apiKey,
      knowledgeBaseId,
      tenantId: tenantRaw || null,
      requestTimeoutMs: readLimit(env, 'WEKNORA_REQUEST_TIMEOUT_MS', 'requestTimeoutMs'),
      searchTimeoutMs: readLimit(env, 'WEKNORA_SEARCH_TIMEOUT_MS', 'searchTimeoutMs'),
      chatTimeoutMs: readLimit(env, 'WEKNORA_CHAT_TIMEOUT_MS', 'chatTimeoutMs'),
      maxCandidates: readLimit(env, 'WEKNORA_MAX_CANDIDATES', 'maxCandidates'),
      maxScopeDocuments: readLimit(env, 'WEKNORA_MAX_SCOPE_DOCUMENTS', 'maxScopeDocuments'),
      maxResponseBytes: readLimit(env, 'WEKNORA_MAX_RESPONSE_BYTES', 'maxResponseBytes'),
      exportBatchSize: readLimit(env, 'WEKNORA_EXPORT_BATCH_SIZE', 'exportBatchSize'),
      exportMaxAttempts: readLimit(env, 'WEKNORA_EXPORT_MAX_ATTEMPTS', 'exportMaxAttempts'),
      maxQuestionChars: readLimit(env, 'WEKNORA_MAX_QUESTION_CHARS', 'maxQuestionChars'),
      maxSnippetChars: readLimit(env, 'WEKNORA_MAX_SNIPPET_CHARS', 'maxSnippetChars'),
      maxAnswerChars: readLimit(env, 'WEKNORA_MAX_ANSWER_CHARS', 'maxAnswerChars'),
    },
  };
}

export interface AiStatus {
  retrieval: AiMode;
  generation: AiMode;
  /** Origin only, so an operator can see which endpoint is bound without the token. */
  endpoint: string | null;
  knowledgeBaseId: string | null;
  /** Present so callers can prove a key is configured without revealing it. */
  apiKeyConfigured: boolean;
}

/** The only shape of the AI configuration that may leave the server process. */
export function describeAiConfig(config: AiConfig): AiStatus {
  return {
    retrieval: config.retrieval,
    generation: config.generation,
    endpoint: config.weknora?.baseUrl ?? null,
    knowledgeBaseId: config.weknora?.knowledgeBaseId ?? null,
    apiKeyConfigured: Boolean(config.weknora?.apiKey),
  };
}
