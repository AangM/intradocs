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

  console.log('');
  console.log('WeKnora lokal siap. AI IntraDocs masih OFF sampai Anda mengaktifkannya sendiri:');
  console.log('  1. Ubah AI_PROVIDER=weknora-local di .env.local (retrieval).');
  console.log(
    '  2. Opsional AI_GENERATION=weknora-local setelah model KnowledgeQA lokal terdaftar.',
  );
  console.log('  3. Jalankan pnpm weknora:sync untuk mengindeks dokumen final-approved.');
  console.log('  4. Setelah bootstrap, set WEKNORA_DISABLE_REGISTRATION=true lalu restart profil.');
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

async function main(): Promise<void> {
  const action = process.argv[2];
  if (action === 'setup') return setup();
  if (action === 'sync') return sync();
  if (action === 'status') return status();
  if (action === 'model') return registerExternalModel();
  if (action === 'stop') {
    loadLocalEnv();
    command('docker', ['compose', '--env-file', '.env.local', '--profile', 'weknora', 'stop']);
    console.log('Profil WeKnora berhenti; volume dan index dipertahankan.');
    return;
  }
  throw new Error(
    'Gunakan: pnpm weknora:setup | weknora:sync | weknora:status | weknora:model | weknora:stop.',
  );
}

main().catch(reportFailure);
