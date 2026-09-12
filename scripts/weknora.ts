// Local WeKnora lifecycle: provision, bootstrap, sync, status, stop.
//
// Everything this script writes is a local-dev credential. Secrets land in .env.local
// and var/ (both git-ignored, 0600); nothing is printed, and nothing is sent anywhere
// but the loopback WeKnora. Enabling AI is still a separate, deliberate edit: this
// script never flips AI_PROVIDER for you.
import { existsSync } from 'node:fs';
import { appendFile, readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import path from 'node:path';
import { Pool } from 'pg';
import { ROOT, loadLocalEnv, localAdminUrl, command, reportFailure } from './shared.ts';
import { readAiConfig, assertLoopbackHttpOrigin } from '../packages/core/src/ai-config.ts';
import { readWorkerConfig } from '../packages/core/src/config.ts';
import { WeknoraClient } from '../packages/core/src/weknora.ts';
import { LocalBlobStore } from '../packages/core/src/storage.ts';
import { processRagExport, sweepRagOrphans, buildExportPayload } from '../packages/core/src/rag.ts';
import { ABSTAIN_MESSAGE } from '../packages/core/src/rag-messages.ts';
import { PostgresRagExportRepository, WeknoraIndexTarget } from '../apps/worker/src/rag-export.ts';

const ENV_FILE = path.join(ROOT, '.env.local');
const SERVICE_FILE = path.join(ROOT, 'var/weknora-service.json');
const DEFAULT_PORT = '58080';

type ServiceAccount = { email: string; password: string; username: string };

const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function secret(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}

async function envMap(): Promise<Map<string, string>> {
  const text = await readFile(ENV_FILE, 'utf8');
  const map = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf('=');
    if (at > 0 && !line.trimStart().startsWith('#'))
      map.set(line.slice(0, at).trim(), line.slice(at + 1));
  }
  return map;
}

/** Adds keys that are missing. Never rewrites one that already has a value. */
async function ensureEnv(entries: Record<string, string>): Promise<Map<string, string>> {
  const current = await envMap();
  const missing = Object.entries(entries).filter(([key]) => !current.get(key));
  if (missing.length > 0) {
    await appendFile(ENV_FILE, missing.map(([k, v]) => `${k}=${v}`).join('\n') + '\n', {
      mode: 0o600,
    });
    for (const [k, v] of missing) current.set(k, v);
    console.log(
      `Menambahkan ${missing.length} variabel WeKnora ke .env.local (nilai tidak dicetak).`,
    );
  }
  return current;
}

/** Sets one key, replacing an existing value; used where a pin must move, not merely exist. */
async function setEnv(key: string, value: string): Promise<void> {
  const text = await readFile(ENV_FILE, 'utf8');
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((line) => line.startsWith(`${key}=`));
  if (at >= 0) lines[at] = `${key}=${value}`;
  else lines.push(`${key}=${value}`);
  await writeFile(ENV_FILE, lines.join('\n').replace(/\n*$/, '\n'), { mode: 0o600 });
}

/**
 * WeKnora runs its own PostgreSQL (ParadeDB) container.
 *
 * Sharing the IntraDocs instance was the first design and it does not work: WeKnora's
 * postgres retrieval driver creates pg_search, which the pgvector image does not ship,
 * so its migrations abort halfway and leave a schema that fails at registration. A
 * separate instance also guarantees a WeKnora migration can never reach IntraDocs data.
 * This removes anything an earlier attempt left inside the IntraDocs instance.
 */
async function dropSharedDatabaseAttempt(): Promise<void> {
  const pool = new Pool({ connectionString: localAdminUrl(), max: 1 });
  try {
    const present = await pool.query("SELECT 1 FROM pg_database WHERE datname='weknora'");
    if (present.rowCount) {
      await pool.query('DROP DATABASE weknora');
      console.log(
        'Database weknora di instance IntraDocs dihapus; WeKnora memakai instance sendiri.',
      );
    }
    if ((await pool.query("SELECT 1 FROM pg_roles WHERE rolname='weknora'")).rowCount)
      await pool.query('DROP ROLE weknora');
  } finally {
    await pool.end();
  }
}

async function waitForHealth(baseUrl: string, seconds: number): Promise<void> {
  for (let i = 0; i < seconds; i++) {
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(
    'WeKnora tidak menjadi healthy. Periksa: docker compose --env-file .env.local --profile weknora logs weknora-app',
  );
}

async function api(
  baseUrl: string,
  method: string,
  route: string,
  options: { body?: unknown; token?: string } = {},
): Promise<Record<string, unknown>> {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(30_000),
    redirect: 'error',
  });
  const text = await response.text();
  if (!response.ok)
    throw new Error(`WeKnora ${method} ${route} gagal dengan status ${response.status}.`);
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`WeKnora ${method} ${route} tidak mengembalikan JSON.`);
  }
}

function pick(body: Record<string, unknown>): Record<string, unknown> {
  const data = body.data;
  return data && typeof data === 'object' && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : body;
}

async function serviceAccount(): Promise<ServiceAccount> {
  if (existsSync(SERVICE_FILE))
    return JSON.parse(await readFile(SERVICE_FILE, 'utf8')) as ServiceAccount;
  const account: ServiceAccount = {
    username: 'intradocs-service',
    email: 'intradocs-service@local.test',
    // WeKnora may enforce a complexity policy; satisfy it without a weak fallback.
    password: `Aa1!${secret(18)}`,
  };
  await mkdir(path.dirname(SERVICE_FILE), { recursive: true, mode: 0o700 });
  await writeFile(SERVICE_FILE, JSON.stringify(account, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  return account;
}

async function setup(): Promise<void> {
  loadLocalEnv();
  const env = await ensureEnv({
    WEKNORA_PORT: DEFAULT_PORT,
    WEKNORA_DB_PASSWORD: secret(32),
    WEKNORA_REDIS_PASSWORD: secret(24),
    WEKNORA_JWT_SECRET: secret(32),
    // SYSTEM_AES_KEY must be exactly 32 bytes; base64url of 24 bytes is 32 chars.
    WEKNORA_AES_KEY: secret(24),
    WEKNORA_EMBEDDING_MODEL: 'bge-m3',
    WEKNORA_EMBEDDING_DIMENSION: '1024',
    WEKNORA_OLLAMA_URL: 'http://host.docker.internal:11434',
  });
  const port = env.get('WEKNORA_PORT') ?? DEFAULT_PORT;
  const baseUrl = assertLoopbackHttpOrigin(`http://127.0.0.1:${port}`, 'WEKNORA_BASE_URL');

  await dropSharedDatabaseAttempt();
  command('docker', [
    'compose',
    '--env-file',
    '.env.local',
    '--profile',
    'weknora',
    'up',
    '-d',
    'weknora-postgres',
    'weknora-redis',
    'weknora-app',
  ]);
  console.log('Menunggu WeKnora siap (maksimal 180 detik)…');
  await waitForHealth(baseUrl, 180);

  const account = await serviceAccount();
  // Register is idempotent enough for local dev: a duplicate simply fails and we log in.
  try {
    await api(baseUrl, 'POST', '/api/v1/auth/register', { body: account });
    console.log('Akun layanan WeKnora dibuat; credential hanya di var/weknora-service.json.');
  } catch {
    console.log('Akun layanan WeKnora sudah ada; melanjutkan dengan login.');
  }
  const login = pick(
    await api(baseUrl, 'POST', '/api/v1/auth/login', {
      body: { email: account.email, password: account.password },
    }),
  );
  const token = typeof login.token === 'string' ? login.token : '';
  if (!token) throw new Error('WeKnora tidak mengembalikan token login.');

  let apiKey = env.get('WEKNORA_API_KEY') ?? '';
  let tenantId = env.get('WEKNORA_TENANT_ID') ?? '';
  if (!apiKey) {
    const tenant = pick(
      await api(baseUrl, 'POST', '/api/v1/tenants', {
        token,
        body: { name: 'IntraDocs', description: 'Index sintetis IntraDocs (local-dev).' },
      }),
    );
    apiKey = typeof tenant.api_key === 'string' ? tenant.api_key : '';
    tenantId = tenant.id === undefined ? '' : String(tenant.id);
    if (!apiKey)
      throw new Error(
        'WeKnora tidak mengembalikan API key. Pastikan WEKNORA_TENANT_AUTO_CREATE_API_KEY=true lalu ulangi.',
      );
    await ensureEnv({ WEKNORA_API_KEY: apiKey, WEKNORA_TENANT_ID: tenantId });
  }

  const headers = { 'X-API-Key': apiKey, ...(tenantId ? { 'X-Tenant-ID': tenantId } : {}) };
  const withKey = async (method: string, route: string, body?: unknown) => {
    const response = await fetch(`${baseUrl}${route}`, {
      method,
      headers: { ...headers, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
      redirect: 'error',
    });
    if (!response.ok)
      throw new Error(`WeKnora ${method} ${route} gagal dengan status ${response.status}.`);
    return pick((await response.json()) as Record<string, unknown>);
  };

  let knowledgeBaseId = env.get('WEKNORA_KNOWLEDGE_BASE_ID') ?? '';
  if (!knowledgeBaseId) {
    const modelName = env.get('WEKNORA_EMBEDDING_MODEL') ?? 'bge-m3';
    const dimension = Number(env.get('WEKNORA_EMBEDDING_DIMENSION') ?? '1024');
    const model = await withKey('POST', '/api/v1/models', {
      name: modelName,
      display_name: `Ollama ${modelName}`,
      type: 'Embedding',
      source: 'local',
      parameters: {
        base_url: env.get('WEKNORA_OLLAMA_URL') ?? 'http://host.docker.internal:11434',
        embedding_parameters: { dimension },
      },
    });
    const modelId = typeof model.id === 'string' ? model.id : '';
    if (!modelId) throw new Error('WeKnora tidak mengembalikan ID model embedding.');
    const kb = await withKey('POST', '/api/v1/knowledge-bases', {
      name: 'intradocs-synthetic',
      description: 'Satu knowledge base sintetis untuk M4. Dikelola exporter IntraDocs.',
      type: 'document',
      embedding_model_id: modelId,
      // Vector + keyword only. Graph and wiki pipelines cost CPU and storage that M4
      // does not need, so they are switched off rather than left to defaults.
      indexing_strategy: {
        vector_enabled: true,
        keyword_enabled: true,
        graph_enabled: false,
        wiki_enabled: false,
      },
      chunking_config: { chunk_size: 400, chunk_overlap: 40, enable_parent_child: false },
    });
    knowledgeBaseId = typeof kb.id === 'string' ? kb.id : '';
    if (!knowledgeBaseId) throw new Error('WeKnora tidak mengembalikan ID knowledge base.');
    await ensureEnv({ WEKNORA_KNOWLEDGE_BASE_ID: knowledgeBaseId, WEKNORA_BASE_URL: baseUrl });
  }
  await ensureEnv({ WEKNORA_BASE_URL: baseUrl });

  // Registration exists for exactly one moment: creating the service account above. Left
  // open afterwards, anyone who reaches the loopback port can mint their own tenant and
  // API key, which is a second door into the index that IntraDocs does not control. This
  // used to be step 4 of a printed checklist; a printed checklist is not a guard, so the
  // setup closes the door itself and restarts the container that reads the flag.
  await ensureEnv({ WEKNORA_DISABLE_REGISTRATION: 'true' });
  command('docker', [
    'compose',
    '--env-file',
    '.env.local',
    '--profile',
    'weknora',
    'up',
    '-d',
    '--force-recreate',
    'weknora-app',
  ]);
  await waitForHealth(baseUrl, 180);
  await assertRegistrationClosed(baseUrl);

  console.log('');
  console.log('WeKnora lokal siap. AI IntraDocs masih OFF sampai Anda mengaktifkannya sendiri:');
  console.log('  1. Ubah AI_PROVIDER=weknora-local di .env.local (retrieval).');
  console.log(
    '  2. Opsional AI_GENERATION=weknora-local setelah model KnowledgeQA lokal terdaftar.',
  );
  console.log('  3. Jalankan pnpm weknora:sync untuk mengindeks dokumen final-approved.');
  console.log('  4. Registrasi WeKnora sudah ditutup otomatis; hanya akun layanan yang ada.');
}

/**
 * Proves the door is shut rather than assuming the environment variable took effect.
 * WeKnora reports its own mode, so this asks it instead of trusting our own compose file.
 */
async function assertRegistrationClosed(baseUrl: string): Promise<void> {
  const response = await fetch(`${baseUrl}/api/v1/auth/config`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
    redirect: 'error',
  });
  const mode = pick((await response.json()) as Record<string, unknown>).registration_mode;
  if (mode === 'self_serve')
    throw new Error(
      'WeKnora masih menerima registrasi terbuka setelah bootstrap. Periksa WEKNORA_DISABLE_REGISTRATION di .env.local lalu ulangi pnpm weknora:setup.',
    );
  console.log(`Registrasi WeKnora ditutup (registration_mode=${String(mode)}).`);
}

async function withWorkerDb<T>(run: (pool: Pool) => Promise<T>): Promise<T> {
  loadLocalEnv();
  const worker = readWorkerConfig(process.env);
  const pool = new Pool({ connectionString: worker.databaseUrl, max: 2 });
  try {
    return await run(pool);
  } finally {
    await pool.end();
  }
}

async function sync(): Promise<void> {
  await withWorkerDb(async (pool) => {
    const ai = readAiConfig(process.env);
    if (!ai.weknora)
      throw new Error('AI_PROVIDER masih off. Aktifkan weknora-local sebelum mengindeks.');
    const root = process.env.INTRADOCS_ROOT ?? ROOT;
    const storage = new LocalBlobStore(
      path.resolve(root, process.env.STORAGE_ROOT ?? 'var/storage'),
    );
    const repository = new PostgresRagExportRepository(pool);
    const index = new WeknoraIndexTarget(new WeknoraClient(ai.weknora));
    // The same two steps the worker runs on its timer, so a manual sync and the
    // background loop cannot diverge: enqueue from the database, then drain.
    const queued = await repository.reconcile();
    let processed = 0;
    while (
      await processRagExport({
        repository,
        index,
        read: (key, hash) => storage.read(key, hash),
        digest: sha256Hex,
      })
    ) {
      processed += 1;
      if (processed >= 500) break;
    }
    const swept = await sweepRagOrphans({ repository, index });
    const { rows } = await pool.query<{ state: string; total: string }>(
      'SELECT state,total FROM app.rag_export_status()',
    );
    console.log(
      `Sinkronisasi selesai: ${queued} diantre, ${processed} diproses, ${swept.removed} yatim disapu dari ${swept.scanned} record. Antrean: ${
        rows.map((r) => `${r.state}=${r.total}`).join(' ') || 'kosong'
      }`,
    );
    if (rows.some((r) => r.state === 'dead' && Number(r.total) > 0)) process.exitCode = 1;
  });
}

async function status(): Promise<void> {
  loadLocalEnv();
  const ai = readAiConfig(process.env);
  console.log(`AI_PROVIDER: ${ai.retrieval} · AI_GENERATION: ${ai.generation}`);
  if (!ai.weknora) {
    console.log('WeKnora tidak dikonfigurasi. Reader, auth, katalog dan pencarian tetap berjalan.');
    return;
  }
  console.log(`Endpoint: ${ai.weknora.baseUrl} · knowledge base: ${ai.weknora.knowledgeBaseId}`);
  console.log('API key: dikonfigurasi (tidak dicetak).');
  const client = new WeknoraClient(ai.weknora);
  console.log(`Liveness /health: ${(await client.health()) ? 'ok' : 'gagal'}`);
  console.log(
    `Knowledge base terjangkau dengan key ini: ${(await client.knowledgeBaseReachable()) ? 'ya' : 'tidak'}`,
  );
  // Registration drifting back open is silent otherwise: nothing fails, there is simply a
  // second way to mint an API key for this index. Reported every time status is asked.
  try {
    const response = await fetch(`${ai.weknora.baseUrl}/api/v1/auth/config`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
    });
    const mode = pick((await response.json()) as Record<string, unknown>).registration_mode;
    console.log(
      mode === 'self_serve'
        ? 'Registrasi WeKnora: TERBUKA. Set WEKNORA_DISABLE_REGISTRATION=true lalu recreate weknora-app.'
        : `Registrasi WeKnora: tertutup (${String(mode)}).`,
    );
  } catch {
    console.log('Registrasi WeKnora: tidak dapat diperiksa.');
  }
  await withWorkerDb(async (pool) => {
    const { rows } = await pool.query<{ state: string; total: string }>(
      'SELECT state,total FROM app.rag_export_status()',
    );
    const indexed = rows.find((r) => r.state === 'indexed')?.total ?? '0';
    const queue = rows.filter((r) => r.state !== 'indexed');
    console.log(`Index: ${indexed} versi terindeks.`);
    console.log(
      queue.length
        ? `Antrean: ${queue.map((r) => `${r.state}=${r.total}`).join(' ')}`
        : 'Antrean: kosong. Jalankan pnpm weknora:sync.',
    );
  });
}

/**
 * Registers an external generation model inside WeKnora.
 *
 * The provider key is read from the environment and never printed, never written to a
 * file this script owns, and never returned in any response: it goes straight into
 * WeKnora's own model record. WeKnora is what talks to the provider; IntraDocs still
 * only ever connects to loopback. That is precisely why AI_GENERATION_LOCATION exists --
 * the egress is one hop further out than IntraDocs can observe, so it has to be declared
 * rather than detected.
 */
async function registerExternalModel(): Promise<void> {
  loadLocalEnv();
  const ai = readAiConfig(process.env);
  if (!ai.weknora) throw new Error('AI_PROVIDER masih off. Aktifkan weknora-local dulu.');
  const key = process.env.EXTERNAL_MODEL_API_KEY ?? '';
  if (!key.trim())
    throw new Error(
      'Isi EXTERNAL_MODEL_API_KEY di .env.local dengan kunci provider Anda. ' +
        'Script ini tidak pernah mencetak atau menyalin kunci tersebut.',
    );
  const provider = process.env.EXTERNAL_MODEL_SOURCE ?? 'openai';
  const model = process.env.EXTERNAL_MODEL_NAME ?? 'gpt-4o-mini';
  const baseUrl = process.env.EXTERNAL_MODEL_BASE_URL ?? 'https://api.openai.com/v1';
  if (!/^https:\/\//.test(baseUrl))
    throw new Error('EXTERNAL_MODEL_BASE_URL harus https; kunci tidak dikirim lewat http.');
  if (ai.generationLocation !== 'external')
    throw new Error(
      'Setel AI_GENERATION_LOCATION=external dan AI_EXTERNAL_ACKNOWLEDGED=synthetic-corpus-only ' +
        'lebih dulu, supaya portal memberi tahu pengguna bahwa jawaban disusun di luar mesin ini.',
    );

  const client = new WeknoraClient(ai.weknora);
  const created = await client.registerModel({
    name: model,
    displayName: `${provider} ${model}`,
    type: 'KnowledgeQA',
    source: provider,
    parameters: { api_key: key, base_url: baseUrl },
  });
  console.log(`Model ${provider}/${model} terdaftar di WeKnora (id ${created}).`);
  console.log('Kunci disimpan di WeKnora, tidak dicetak dan tidak disalin ke berkas lain.');
  console.log('Jalankan pnpm weknora:status untuk memastikan, lalu restart pnpm dev.');
}

/**
 * Auto-tag experiment, repeatable: `pnpm weknora:autotag <ollama-model>`.
 *
 * Seeds WeKnora's tag pool from IntraDocs labels, points the auto-tagger at a local
 * Ollama model, reparses every indexed document, then prints what the model chose next
 * to what IntraDocs would accept. Nothing is written to IntraDocs: the point of the table
 * is to judge a model before anyone relies on its suggestions.
 */
async function autotag(): Promise<void> {
  loadLocalEnv();
  const ai = readAiConfig(process.env);
  if (!ai.weknora) throw new Error('AI_PROVIDER masih off. Aktifkan weknora-local dulu.');
  const modelName = process.argv[3] ?? '';
  if (!/^[a-z0-9][a-z0-9._\/-]*(:[a-z0-9._-]+)?$/i.test(modelName))
    throw new Error(
      'Gunakan: pnpm weknora:autotag <nama-model-ollama>, misal qwen2.5:3b-instruct.',
    );

  // The model has to exist locally first; WeKnora would otherwise try to pull it itself.
  const ollamaHost = assertLoopbackHttpOrigin(
    process.env.OLLAMA_HOST_URL ?? 'http://127.0.0.1:11434',
    'OLLAMA_HOST_URL',
  );
  const tags = (await (
    await fetch(`${ollamaHost}/api/tags`, { signal: AbortSignal.timeout(10_000) })
  ).json()) as {
    models?: Array<{ name?: string }>;
  };
  if (!(tags.models ?? []).some((m) => m.name === modelName))
    throw new Error(
      `Model ${modelName} belum ada di Ollama lokal. Jalankan: ollama pull ${modelName}`,
    );

  const client = new WeknoraClient(ai.weknora);
  let model = (await client.listModels()).find(
    (m) => m.type === 'KnowledgeQA' && m.source === 'local' && m.name === modelName,
  );
  if (!model) {
    const id = await client.registerModel({
      name: modelName,
      displayName: `ollama ${modelName}`,
      type: 'KnowledgeQA',
      source: 'local',
      parameters: {
        base_url: process.env.WEKNORA_OLLAMA_URL ?? 'http://host.docker.internal:11434',
      },
    });
    model = { id, name: modelName, type: 'KnowledgeQA', source: 'local' };
    console.log(`Model ${modelName} terdaftar di WeKnora (id ${id}).`);
  }

  // Vocabulary and index mapping come from IntraDocs; labels are per category there.
  const admin = new Pool({ connectionString: localAdminUrl(), max: 1 });
  let docs: Array<{
    knowledgeId: string;
    title: string;
    category: string;
    labels: string[];
    vocabulary: string[];
  }>;
  let labelNames: string[];
  try {
    labelNames = (
      await admin.query<{ name: string }>(
        'SELECT DISTINCT name FROM app.labels WHERE merged_into IS NULL ORDER BY name',
      )
    ).rows.map((r) => r.name);
    docs = (
      await admin.query<{
        knowledge_id: string;
        title: string;
        category: string;
        labels: string[];
        vocabulary: string[] | null;
      }>(
        `SELECT e.knowledge_id, v.title, c.name AS category, v.labels,
           (SELECT array_agg(l.name ORDER BY l.name) FROM app.labels l
             WHERE l.category_id=v.category_id AND l.merged_into IS NULL) AS vocabulary
         FROM app.rag_index_entries e
         JOIN app.document_versions v ON v.id=e.version_id
         JOIN app.categories c ON c.id=v.category_id
         ORDER BY v.title`,
      )
    ).rows.map((r) => ({
      knowledgeId: r.knowledge_id,
      title: r.title,
      category: r.category,
      labels: r.labels,
      vocabulary: r.vocabulary ?? [],
    }));
  } finally {
    await admin.end();
  }
  if (docs.length === 0)
    throw new Error('Belum ada dokumen terindeks; jalankan pnpm weknora:sync dulu.');

  // Tags accumulate across runs in WeKnora, which would blur one model's verdict into the
  // next. The pool itself stays (WeKnora refuses to delete a tag that is still attached);
  // what is cleared is every attachment, so the table below is this model's answer and
  // nobody else's. Label suggestions in the portal are empty for the few minutes this takes.
  const existing = (await client.listTags()).map((t) => t.name);
  for (const name of labelNames) if (!existing.includes(name)) await client.createTag(name);
  await client.clearKnowledgeTags(docs.map((d) => d.knowledgeId));
  console.log(
    `Kolam tag WeKnora: ${labelNames.length} label IntraDocs; tag lama dilepas dari ${docs.length} dokumen.`,
  );

  // skip_if_tagged=false so a rerun with a different model replaces the previous verdict.
  await client.setAutoTag({ enabled: true, modelId: model.id, maxTags: 5, skipIfTagged: false });
  const triggeredAt = Date.now() - 5_000; // clock skew between host and container
  await client.reparseKnowledge(docs.map((d) => d.knowledgeId));
  console.log(
    `Reparse ${docs.length} dokumen dengan ${modelName}; menunggu parse lalu tag (maks 10 menit)...`,
  );

  // Two phases. Parsing is observable: updated_at moves past the trigger and the status
  // returns to completed. Tagging is a separate queued task with no status of its own,
  // so after every parse has landed the tags are given a fixed window to appear and a
  // short quiet period to settle; the table reports whatever exists at the end.
  const deadline = Date.now() + 10 * 60_000;
  const parsed = new Set<string>();
  while (Date.now() < deadline && parsed.size < docs.length) {
    await new Promise((r) => setTimeout(r, 10_000));
    for (const d of docs) {
      if (parsed.has(d.knowledgeId)) continue;
      const state = await client.knowledgeState(d.knowledgeId);
      if (state.parseStatus === 'completed' && state.updatedAt >= triggeredAt)
        parsed.add(d.knowledgeId);
    }
  }
  if (parsed.size < docs.length)
    console.log(
      `Catatan: ${docs.length - parsed.size} dokumen belum selesai parse dalam batas waktu.`,
    );
  const result = new Map<string, string[]>();
  let quiet = 0;
  let last = '';
  while (Date.now() < deadline && quiet < 4) {
    await new Promise((r) => setTimeout(r, 15_000));
    for (const d of docs)
      result.set(d.knowledgeId, (await client.knowledgeState(d.knowledgeId)).tags);
    const snapshot = [...result.values()].map((t) => t.join('|')).join('/');
    quiet = snapshot === last ? quiet + 1 : 0;
    last = snapshot;
  }

  let correct = 0,
    wrong = 0,
    none = 0,
    accepted = 0;
  console.log('');
  console.log('Dokumen | Kategori | Label IntraDocs | Tag model | Lolos penyaring');
  for (const d of docs) {
    const chosen = result.get(d.knowledgeId) ?? [];
    const lower = (x: string) => x.toLowerCase();
    const passes = chosen.filter(
      (t) =>
        d.vocabulary.some((v) => lower(v) === lower(t)) &&
        !d.labels.some((l) => lower(l) === lower(t)),
    );
    const hits = chosen.filter((t) => d.labels.some((l) => lower(l) === lower(t)));
    if (chosen.length === 0) none += 1;
    correct += hits.length;
    wrong += chosen.length - hits.length;
    accepted += passes.length;
    console.log(
      `${d.title.slice(0, 40)} | ${d.category} | ${d.labels.join(', ') || '—'} | ${chosen.join(', ') || '(tidak ada)'} | ${passes.join(', ') || '—'}`,
    );
  }
  console.log('');
  console.log(
    `${modelName}: ${correct} tag cocok label yang ada, ${wrong} tidak cocok, ${none} dokumen tanpa tag, ` +
      `${accepted} saran baru yang akan lolos ke IntraDocs.`,
  );
}

const MAX_COMPLETION_TOKENS = 1024;

/**
 * Answering model, one command: `pnpm weknora:generation <ollama-model>`.
 *
 * The cap on the agent (max_completion_tokens above) is stored by WeKnora but never
 * reaches Ollama's /api/chat as num_predict: a runaway answer was measured at 40,960
 * tokens and 7-15 minutes, with every later request queued behind it until it timed
 * out. Ollama applies a model's own parameters to every request, so the answering
 * model is a derivative of the pulled one with num_predict and a repeat penalty baked
 * in, created through Ollama's API (no Modelfile on disk). That derivative -- not the
 * bare model -- is registered in WeKnora as the KnowledgeQA model, pinned in
 * .env.local, and the agent is re-pinned to it.
 */
async function generationModel(): Promise<void> {
  loadLocalEnv();
  const ai = readAiConfig(process.env);
  if (!ai.weknora) throw new Error('AI_PROVIDER masih off. Aktifkan weknora-local dulu.');
  const base = process.argv[3] ?? '';
  if (!/^[a-z0-9][a-z0-9._\/-]*(:[a-z0-9._-]+)?$/i.test(base))
    throw new Error(
      'Gunakan: pnpm weknora:generation <nama-model-ollama>, misal qwen2.5:1.5b-instruct.',
    );
  const ollamaHost = assertLoopbackHttpOrigin(
    process.env.OLLAMA_HOST_URL ?? 'http://127.0.0.1:11434',
    'OLLAMA_HOST_URL',
  );
  const tags = (await (
    await fetch(`${ollamaHost}/api/tags`, { signal: AbortSignal.timeout(10_000) })
  ).json()) as { models?: Array<{ name?: string }> };
  if (!(tags.models ?? []).some((m) => m.name === base))
    throw new Error(`Model ${base} belum ada di Ollama lokal. Jalankan: ollama pull ${base}`);

  const derived = `${base}-intradocs`;
  const created = await fetch(`${ollamaHost}/api/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: derived,
      from: base,
      parameters: { num_predict: MAX_COMPLETION_TOKENS, repeat_penalty: 1.15 },
      stream: false,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!created.ok) throw new Error(`Ollama menolak membuat ${derived}: HTTP ${created.status}`);
  const shown = (await (
    await fetch(`${ollamaHost}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: derived }),
      signal: AbortSignal.timeout(10_000),
    })
  ).json()) as { parameters?: string };
  const parameters = (shown.parameters ?? '')
    .split('\n')
    .map((line) => line.trim().split(/\s+/).join(' '));
  if (!parameters.includes(`num_predict ${MAX_COMPLETION_TOKENS}`))
    throw new Error(`Ollama tidak menyimpan num_predict pada ${derived}; jawaban tidak dibatasi.`);
  console.log(`Model Ollama ${derived} siap (num_predict=${MAX_COMPLETION_TOKENS}).`);

  const client = new WeknoraClient(ai.weknora);
  let model = (await client.listModels()).find(
    (m) => m.type === 'KnowledgeQA' && m.source === 'local' && m.name === derived,
  );
  if (!model) {
    const id = await client.registerModel({
      name: derived,
      displayName: `ollama ${derived}`,
      type: 'KnowledgeQA',
      source: 'local',
      parameters: {
        base_url: process.env.WEKNORA_OLLAMA_URL ?? 'http://host.docker.internal:11434',
      },
    });
    model = { id, name: derived, type: 'KnowledgeQA', source: 'local' };
    console.log(`Model ${derived} terdaftar di WeKnora (id ${id}).`);
  }
  await setEnv('WEKNORA_GENERATION_MODEL_ID', model.id);
  console.log(`WEKNORA_GENERATION_MODEL_ID=${model.id} ditulis ke .env.local.`);
  // loadLocalEnv never overrides a variable already in the process, so hand the new pin
  // to pinAgent directly; otherwise the agent would keep the model read at start-up.
  process.env.WEKNORA_GENERATION_MODEL_ID = model.id;
  await pinAgent();
}

/**
 * Pins the WeKnora agent IntraDocs chats through: `pnpm weknora:agent`.
 *
 * Every optional capability is switched off in the stored configuration -- web search,
 * web fetch, query rewriting and expansion, multi-turn history, tools, MCP, skills,
 * attachments, FAQ boosting, question suggestions -- and the fallback for "nothing
 * retrieved" is a fixed abstention instead of a free model answer. The generation model
 * and, when one exists, the rerank model are pinned here too. The agent id lands in
 * .env.local as WEKNORA_AGENT_ID; restart pnpm dev afterwards.
 */
async function pinAgent(): Promise<void> {
  loadLocalEnv();
  const ai = readAiConfig(process.env);
  if (!ai.weknora) throw new Error('AI_PROVIDER masih off. Aktifkan weknora-local dulu.');
  const rerankModelId = process.env.WEKNORA_RERANK_MODEL_ID ?? '';
  if (rerankModelId && !/^[A-Za-z0-9_-]{8,64}$/.test(rerankModelId))
    throw new Error('WEKNORA_RERANK_MODEL_ID harus ID model WeKnora bila diisi.');
  const client = new WeknoraClient(ai.weknora);
  const id = await client.ensureAgent({
    name: 'intradocs-portal',
    config: {
      agent_mode: 'quick-answer',
      system_prompt_id: 'default_kb',
      context_template_id: 'default_context',
      model_id: ai.weknora.generationModelId ?? '',
      rerank_model_id: rerankModelId,
      temperature: 0.2,
      // 0 means unlimited, and a 1.5B model does occasionally run away: one answer was
      // logged at 40,960 completion tokens, eleven minutes on this GPU, with every later
      // request queued behind it and timing out. A grounded answer to a document question
      // fits comfortably in a few hundred tokens; the cap bounds the worst case.
      max_completion_tokens: MAX_COMPLETION_TOKENS,
      thinking: false,
      citation_enabled: true,
      max_iterations: 1,
      allowed_tools: [],
      mcp_selection_mode: '',
      mcp_services: [],
      skills_selection_mode: '',
      selected_skills: [],
      kb_selection_mode: 'all',
      knowledge_bases: [ai.weknora.knowledgeBaseId],
      retrieve_kb_only_when_mentioned: false,
      retain_retrieval_history: false,
      image_upload_enabled: false,
      audio_upload_enabled: false,
      attachment_image_understanding: false,
      data_analysis_enabled: false,
      faq_priority_enabled: false,
      web_search_enabled: false,
      web_fetch_enabled: false,
      multi_turn_enabled: false,
      history_turns: 0,
      embedding_top_k: 10,
      keyword_threshold: 0.3,
      vector_threshold: 0.5,
      rerank_top_k: 6,
      rerank_threshold: 0.3,
      enable_query_expansion: false,
      enable_rewrite: false,
      fallback_strategy: 'fixed',
      fallback_response: ABSTAIN_MESSAGE,
      question_suggestions: {
        starters: { enabled: false, mode: 'hybrid', items: [], count: 0 },
        follow_ups: { enabled: false, mode: 'hybrid', count: 0, categories: [] },
      },
    },
  });
  // Read back what WeKnora actually stored; a field it silently dropped must be visible.
  const stored = await client.agentConfig(id);
  const expectOff = [
    'web_search_enabled',
    'web_fetch_enabled',
    'multi_turn_enabled',
    'enable_rewrite',
    'enable_query_expansion',
    'image_upload_enabled',
    'audio_upload_enabled',
    'data_analysis_enabled',
    'faq_priority_enabled',
  ];
  const stillOn = expectOff.filter((k) => stored[k] === true);
  if (stillOn.length)
    throw new Error(
      `WeKnora menyimpan agen dengan fitur yang seharusnya mati: ${stillOn.join(', ')}.`,
    );
  if (stored.fallback_strategy !== 'fixed')
    throw new Error(
      `fallback_strategy tersimpan sebagai ${String(stored.fallback_strategy)}, bukan fixed.`,
    );
  if (rerankModelId && stored.rerank_model_id !== rerankModelId)
    throw new Error('WeKnora membuang rerank_model_id pada agen; rerank tidak terpasang.');
  if (Number(stored.max_completion_tokens) !== MAX_COMPLETION_TOKENS)
    throw new Error(
      `max_completion_tokens tersimpan sebagai ${String(stored.max_completion_tokens)}, bukan ${MAX_COMPLETION_TOKENS}; jawaban tidak dibatasi.`,
    );
  await ensureEnv({ WEKNORA_AGENT_ID: id });
  console.log(`Agen intradocs-portal siap (id ${id}); WEKNORA_AGENT_ID ditulis ke .env.local.`);
  console.log(
    `  model=${String(stored.model_id) || '(default tenant)'} rerank=${String(stored.rerank_model_id) || '(tidak ada)'} ` +
      `web=${String(stored.web_search_enabled)} rewrite=${String(stored.enable_rewrite)} history=${String(stored.history_turns)} fallback=${String(stored.fallback_strategy)} max_tokens=${String(stored.max_completion_tokens)}`,
  );
  console.log('Restart pnpm dev agar chat memakai agen ini.');
}

/**
 * Lab knowledge base: `pnpm weknora:lab [--wiki]`.
 *
 * Everything WeKnora can do to a document at ingest -- summary, generated questions,
 * auto-tag, optionally the wiki -- is either fixed at knowledge-base creation or costs
 * inference IntraDocs never asked for. So instead of changing the base the portal reads,
 * a second base is created with all of it on, filled with the SAME synthetic versions the
 * exporter already deemed indexable (approved, published, not withdrawn or expired), and
 * explored through WeKnora's own UI. IntraDocs never reads this base: its id is written to
 * .env.local as WEKNORA_LAB_KNOWLEDGE_BASE_ID for the operator, and readAiConfig ignores
 * that key. The UI shows everything in it regardless of IntraDocs permissions, which is
 * exactly why only the synthetic corpus may ever go there.
 */
async function lab(): Promise<void> {
  loadLocalEnv();
  const ai = readAiConfig(process.env);
  if (!ai.weknora) throw new Error('AI_PROVIDER masih off. Aktifkan weknora-local dulu.');
  const wiki = process.argv.includes('--wiki');
  const client = new WeknoraClient(ai.weknora);

  // The answering model doubles as summary/tag/question model: it is the one that fits.
  const models = await client.listModels();
  const llm =
    models.find((m) => m.id === ai.weknora?.generationModelId) ??
    models.find((m) => m.type === 'KnowledgeQA' && m.source === 'local');
  if (!llm)
    throw new Error(
      'Tidak ada model KnowledgeQA lokal di WeKnora; jalankan pnpm weknora:autotag <model> dulu.',
    );
  const production = asKb(await client.knowledgeBase());
  const embeddingModelId = str(production.embedding_model_id);

  let labId = process.env.WEKNORA_LAB_KNOWLEDGE_BASE_ID ?? '';
  const existing = labId ? await client.knowledgeBase(labId).catch(() => null) : null;
  if (!existing) {
    labId = await client.createKnowledgeBase({
      name: 'intradocs-lab',
      description:
        'Salinan corpus SINTETIS untuk mencoba fitur ingest WeKnora (summary, pertanyaan, tag, wiki). Tidak dibaca IntraDocs.',
      embeddingModelId,
      summaryModelId: llm.id,
      wiki,
      questionGeneration: { enabled: true, questionCount: 3, modelId: llm.id },
      autoTag: { enabled: true, modelId: llm.id },
    });
    await ensureEnv({ WEKNORA_LAB_KNOWLEDGE_BASE_ID: labId });
    console.log(
      `Knowledge base lab dibuat (id ${labId}); ditulis ke .env.local sebagai WEKNORA_LAB_KNOWLEDGE_BASE_ID.`,
    );
  } else {
    console.log(`Knowledge base lab sudah ada (id ${labId}).`);
  }
  const labClient = new WeknoraClient({ ...ai.weknora, knowledgeBaseId: labId });

  // Same tag pool as production, so auto-tag answers the same question there.
  const labels = new Pool({ connectionString: localAdminUrl(), max: 1 });
  type Row = {
    document_id: string;
    version_id: string;
    title: string;
    label: string;
    classification: string;
    category: string;
    markdown_key: string;
    markdown_sha256: string;
  };
  let rows: Row[];
  let labelNames: string[];
  try {
    labelNames = (
      await labels.query<{ name: string }>(
        'SELECT DISTINCT name FROM app.labels WHERE merged_into IS NULL ORDER BY name',
      )
    ).rows.map((r) => r.name);
    // Only what production already indexed: the exporter has applied every eligibility
    // rule (approval, publication, withdrawal, expiry) before a row lands here.
    rows = (
      await labels.query<Row>(
        `SELECT e.document_id, e.version_id, v.title, v.label, v.classification, c.name AS category,
              v.markdown_key, v.markdown_sha256
       FROM app.rag_index_entries e
       JOIN app.document_versions v ON v.id=e.version_id
       JOIN app.categories c ON c.id=v.category_id ORDER BY v.title`,
      )
    ).rows;
  } finally {
    await labels.end();
  }
  const have = await labClient.listTags();
  for (const name of labelNames)
    if (!have.some((t) => t.name === name)) await labClient.createTag(name);

  const storage = new LocalBlobStore(
    path.resolve(process.env.INTRADOCS_ROOT ?? ROOT, process.env.STORAGE_ROOT ?? 'var/storage'),
  );
  const present = new Set((await labClient.listKnowledge()).map((k) => k.title));
  const created: string[] = [];
  for (const r of rows) {
    const markdown = new TextDecoder('utf-8', { fatal: true }).decode(
      await storage.read(r.markdown_key, r.markdown_sha256),
    );
    const payload = buildExportPayload({
      documentId: r.document_id,
      versionId: r.version_id,
      documentTitle: r.title,
      versionLabel: r.label,
      classification: r.classification,
      categoryName: r.category,
      markdown,
    });
    if (present.has(payload.title)) continue;
    created.push(await labClient.createManualKnowledge(payload));
  }
  await labClient.reparseKnowledge(created);
  console.log(
    `${created.length} dokumen baru dikirim ke lab (${rows.length} total terindeks di produksi); parse + summary + pertanyaan + tag berjalan di latar.`,
  );
  console.log('');
  console.log('Buka UI WeKnora ke knowledge base "intradocs-lab":');
  console.log(
    '  docker compose --env-file .env.local --profile weknora --profile weknora-ui up -d weknora-ui',
  );
  console.log(
    `  http://127.0.0.1:${process.env.WEKNORA_UI_PORT ?? '47081'}  (login: akun layanan di var/weknora-service.json)`,
  );
  console.log(
    'IntraDocs tidak membaca knowledge base ini; UI menampilkan semuanya tanpa izin IntraDocs — hanya corpus sintetis.',
  );
}

function asKb(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}
function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

async function main(): Promise<void> {
  const action = process.argv[2];
  if (action === 'setup') return setup();
  if (action === 'sync') return sync();
  if (action === 'status') return status();
  if (action === 'model') return registerExternalModel();
  if (action === 'autotag') return autotag();
  if (action === 'agent') return pinAgent();
  if (action === 'generation') return generationModel();
  if (action === 'lab') return lab();
  if (action === 'stop') {
    loadLocalEnv();
    command('docker', ['compose', '--env-file', '.env.local', '--profile', 'weknora', 'stop']);
    console.log('Profil WeKnora berhenti; volume dan index dipertahankan.');
    return;
  }
  throw new Error(
    'Gunakan: pnpm weknora:setup | weknora:sync | weknora:status | weknora:model | weknora:generation | weknora:autotag | weknora:agent | weknora:lab | weknora:stop.',
  );
}

main().catch(reportFailure);
