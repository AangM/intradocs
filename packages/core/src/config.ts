export interface RuntimeConfig {
  profile: 'local-dev';
  appUrl: string;
  rootDir: string;
  storageRoot: string;
  databaseUrl: string;
  authDatabaseUrl: string;
  authSecret: string;
}
export class ConfigurationError extends Error {}
const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
export function assertLocalDatabase(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigurationError('URL database tidak valid.');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !localHosts.has(url.hostname)) {
    throw new ConfigurationError('Build M0/M1 ini hanya untuk database lokal.');
  }
  return url;
}
export function readRuntimeConfig(env: Record<string, string | undefined>): RuntimeConfig {
  if (env.APP_PROFILE !== 'local-dev')
    throw new ConfigurationError(
      'Hanya APP_PROFILE=local-dev yang telah diimplementasikan. Bukan build produksi Telkom.',
    );
  if (env.AUTH_MODE !== 'local')
    throw new ConfigurationError('SSO/OIDC belum diimplementasikan pada M1.');
  // Off by default. The only alternative is a loopback WeKnora the operator started
  // deliberately; no cloud provider, no fallback and no billing path exists here.
  if (env.AI_PROVIDER !== 'off' && env.AI_PROVIDER !== 'weknora-local')
    throw new ConfigurationError(
      'AI_PROVIDER hanya menerima off atau weknora-local. Provider cloud tidak diimplementasikan.',
    );
  if (env.STORAGE_DRIVER !== 'filesystem')
    throw new ConfigurationError('Adapter S3 belum diimplementasikan. Gunakan filesystem lokal.');
  let app: URL;
  try {
    app = new URL(env.APP_URL ?? '');
  } catch {
    throw new ConfigurationError('APP_URL tidak valid.');
  }
  if (
    app.protocol !== 'http:' ||
    !localHosts.has(app.hostname) ||
    app.username ||
    app.password ||
    app.pathname !== '/' ||
    app.search ||
    app.hash
  )
    throw new ConfigurationError('APP_URL harus origin http localhost pada build lokal.');
  const databaseUrl = env.DATABASE_URL ?? '';
  const authDatabaseUrl = env.AUTH_DATABASE_URL ?? '';
  const a = assertLocalDatabase(databaseUrl);
  const b = assertLocalDatabase(authDatabaseUrl);
  if (
    decodeURIComponent(a.username) !== 'intradocs_app' ||
    decodeURIComponent(b.username) !== 'intradocs_auth'
  )
    throw new ConfigurationError(
      'Pisahkan role DB aplikasi dan autentikasi; jangan memakai postgres/owner.',
    );
  if (a.host !== b.host || a.pathname !== b.pathname)
    throw new ConfigurationError('Auth dan aplikasi harus memakai database lokal yang sama.');
  if (
    (env.BETTER_AUTH_SECRET ?? '').length < 32 ||
    /replace|change.me|example/i.test(env.BETTER_AUTH_SECRET ?? '')
  )
    throw new ConfigurationError('Secret belum aman. Jalankan pnpm setup:local.');
  if (!env.INTRADOCS_ROOT) throw new ConfigurationError('Jalankan pnpm dev dari root repository.');
  if (env.STORAGE_ROOT && !/^var\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(env.STORAGE_ROOT))
    throw new ConfigurationError(
      'Storage M1 harus berada di subfolder privat var/, bukan webroot.',
    );
  return {
    profile: 'local-dev',
    appUrl: app.origin,
    rootDir: env.INTRADOCS_ROOT,
    storageRoot: env.STORAGE_ROOT ?? 'var/storage',
    databaseUrl,
    authDatabaseUrl,
    authSecret: env.BETTER_AUTH_SECRET!,
  };
}

export function readWorkerConfig(env: Record<string, string | undefined>): { databaseUrl: string } {
  if (env.APP_PROFILE !== 'local-dev')
    throw new ConfigurationError('Worker hanya berjalan pada profil local-dev.');
  if (env.AI_PROVIDER !== 'off' && env.AI_PROVIDER !== 'weknora-local')
    throw new ConfigurationError('Worker hanya menerima AI_PROVIDER off atau weknora-local.');
  const raw = env.WORKER_DATABASE_URL ?? '';
  const u = assertLocalDatabase(raw);
  if (decodeURIComponent(u.username) !== 'intradocs_worker')
    throw new ConfigurationError('Worker wajib memakai role terpisah.');
  return { databaseUrl: raw };
}
