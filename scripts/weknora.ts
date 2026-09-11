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
import { processRagExport, sweepRagOrphans } from '../packages/core/src/rag.ts';
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

async function main(): Promise<void> {
  const action = process.argv[2];
  if (action === 'setup') return setup();
  if (action === 'sync') return sync();
  if (action === 'status') return status();
  if (action === 'model') return registerExternalModel();
  if (action === 'autotag') return autotag();
  if (action === 'stop') {
    loadLocalEnv();
    command('docker', ['compose', '--env-file', '.env.local', '--profile', 'weknora', 'stop']);
    console.log('Profil WeKnora berhenti; volume dan index dipertahankan.');
    return;
  }
  throw new Error(
    'Gunakan: pnpm weknora:setup | weknora:sync | weknora:status | weknora:model | weknora:autotag | weknora:stop.',
  );
}

main().catch(reportFailure);
