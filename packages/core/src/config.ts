export type Profile = 'local-dev' | 'staging' | 'production';
export interface RuntimeConfig {
  profile: Profile;
  appUrl: string;
  rootDir: string;
  storageRoot: string;
  databaseUrl: string;
  authDatabaseUrl: string;
  authSecret: string;
  /** True for staging and production: HSTS, secure cookies, no demo affordances. */
  hardened: boolean;
  /**
   * The organisation's OpenID Connect provider, when AUTH_MODE=oidc. Identities are
   * still created by invitation: SSO only proves that the person at the keyboard is the
   * one an admin invited, it never provisions a new account.
   */
  sso: SsoConfig | null;
}
export interface SsoConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Button label on the login page, e.g. the IdP's name. */
  label: string;
}
export class ConfigurationError extends Error {}
const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
export const PROFILES: readonly Profile[] = ['local-dev', 'staging', 'production'];
export function isProfile(value: unknown): value is Profile {
  return typeof value === 'string' && (PROFILES as readonly string[]).includes(value);
}
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
/**
 * A database URL a hardened profile may use. Any host is allowed -- a deployment has its
 * database somewhere -- but a connection that leaves the machine must be encrypted, and
 * the verifying mode is the only one that also authenticates the server. `sslmode=require`
 * is accepted with the understanding that it encrypts without proving who answers;
 * `verify-full` is what the deployment guide asks for.
 */
export function assertDeployedDatabase(value: string, trustedNetwork = false): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigurationError('URL database tidak valid.');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol))
    throw new ConfigurationError('URL database harus memakai skema postgres.');
  if (!url.hostname) throw new ConfigurationError('URL database tidak menyebut host.');
  const sslmode = url.searchParams.get('sslmode');
  if (sslmode && !['require', 'verify-ca', 'verify-full', 'disable'].includes(sslmode))
    throw new ConfigurationError('sslmode tidak dikenal.');
  const encrypted = ['require', 'verify-ca', 'verify-full'].includes(sslmode ?? '');
  // Loopback never leaves the machine. A private bridge network (the app and its database
  // as two containers on one host) does not either, but only the operator can say that is
  // what this is -- so it takes an explicit DATABASE_PRIVATE_NETWORK=true, which is a
  // sentence someone has to write down and a reviewer can find, rather than a default.
  if (!encrypted && !localHosts.has(url.hostname) && !trustedNetwork)
    throw new ConfigurationError(
      'Koneksi database lintas host wajib TLS: tambahkan sslmode=verify-full, ' +
        'atau nyatakan DATABASE_PRIVATE_NETWORK=true bila database berada di jaringan privat yang sama.',
    );
  return url;
}
/** A placeholder secret is worse than none: it looks configured and is public knowledge. */
function assertSecret(value: string | undefined, minimum: number): string {
  const secret = value ?? '';
  if (secret.length < minimum)
    throw new ConfigurationError(`Secret minimal ${minimum} karakter. Jalankan pnpm setup:local.`);
  if (/replace|change.?me|example|secret|password|intradocs|telkom|test/i.test(secret))
    throw new ConfigurationError('Secret mengandung kata yang dapat ditebak. Buat yang acak.');
  if (new Set(secret).size < 12)
    throw new ConfigurationError('Secret terlalu sedikit variasi karakternya.');
  return secret;
}

export function readRuntimeConfig(env: Record<string, string | undefined>): RuntimeConfig {
  const profile = env.APP_PROFILE;
  if (!isProfile(profile))
    throw new ConfigurationError(
      `APP_PROFILE harus salah satu dari ${PROFILES.join(', ')}; tidak ada default.`,
    );
  const hardened = profile !== 'local-dev';
  if (env.AUTH_MODE !== 'local' && env.AUTH_MODE !== 'oidc')
    throw new ConfigurationError('AUTH_MODE hanya menerima local atau oidc.');
  // Off by default. The only alternative is a WeKnora the operator started deliberately;
  // no cloud provider, no fallback and no billing path exists here.
  if (env.AI_PROVIDER !== 'off' && env.AI_PROVIDER !== 'weknora-local')
    throw new ConfigurationError(
      'AI_PROVIDER hanya menerima off atau weknora-local. Provider cloud tidak diimplementasikan.',
    );
  if (env.STORAGE_DRIVER !== 'filesystem')
    throw new ConfigurationError('Adapter S3 belum diimplementasikan. Gunakan filesystem.');
  let app: URL;
  try {
    app = new URL(env.APP_URL ?? '');
  } catch {
    throw new ConfigurationError('APP_URL tidak valid.');
  }
  if (app.username || app.password || app.pathname !== '/' || app.search || app.hash)
    throw new ConfigurationError('APP_URL harus origin bersih tanpa path, query atau kredensial.');
  if (hardened) {
    // Cookies are Secure and SameSite on a deployment; plain HTTP would silently drop
    // the session instead of failing loudly, so the origin must be https.
    if (app.protocol !== 'https:') throw new ConfigurationError('APP_URL profil ini wajib https.');
    if (localHosts.has(app.hostname))
      throw new ConfigurationError('APP_URL profil ini harus hostname yang dapat dijangkau.');
  } else if (app.protocol !== 'http:' || !localHosts.has(app.hostname))
    throw new ConfigurationError('APP_URL harus origin http localhost pada build lokal.');

  const databaseUrl = env.DATABASE_URL ?? '';
  const authDatabaseUrl = env.AUTH_DATABASE_URL ?? '';
  // Acknowledged once, for every connection this process makes.
  const trustedNetwork = env.DATABASE_PRIVATE_NETWORK === 'true';
  const check = hardened
    ? (url: string) => assertDeployedDatabase(url, trustedNetwork)
    : assertLocalDatabase;
  const a = check(databaseUrl);
  const b = check(authDatabaseUrl);
  if (
    decodeURIComponent(a.username) !== 'intradocs_app' ||
    decodeURIComponent(b.username) !== 'intradocs_auth'
  )
    throw new ConfigurationError(
      'Pisahkan role DB aplikasi dan autentikasi; jangan memakai postgres/owner.',
    );
  if (a.host !== b.host || a.pathname !== b.pathname)
    throw new ConfigurationError('Auth dan aplikasi harus memakai database yang sama.');
  const authSecret = assertSecret(env.BETTER_AUTH_SECRET, hardened ? 48 : 32);
  const sso = env.AUTH_MODE === 'oidc' ? readSso(env, hardened) : null;
  if (!env.INTRADOCS_ROOT) throw new ConfigurationError('INTRADOCS_ROOT belum diisi.');
  const storageRoot = env.STORAGE_ROOT ?? 'var/storage';
  // Never inside the served tree, whatever the profile. Locally that means a private
  // subfolder of var/; on a deployment an absolute path on a volume the web process
  // owns, which must still not sit under a webroot.
  if (/(^|[\\/])public([\\/]|$)/.test(storageRoot))
    throw new ConfigurationError('STORAGE_ROOT tidak boleh berada di webroot.');
  if (hardened) {
    if (!/^(\/[^\0]*|[A-Za-z]:[\\/][^\0]*)$/.test(storageRoot))
      throw new ConfigurationError('STORAGE_ROOT profil ini harus path absolut.');
    if (/\.\./.test(storageRoot))
      throw new ConfigurationError('STORAGE_ROOT tidak boleh memuat ..');
  } else if (!/^var\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(storageRoot))
    throw new ConfigurationError('Storage lokal harus berada di subfolder privat var/.');
  return {
    profile,
    appUrl: app.origin,
    rootDir: env.INTRADOCS_ROOT,
    storageRoot,
    databaseUrl,
    authDatabaseUrl,
    authSecret,
    hardened,
    sso,
  };
}
/**
 * AUTH_MODE=oidc needs the three things every OIDC relying party needs and nothing
 * else: discovery does the rest. The issuer must be https on a deployment; locally an
 * http issuer on the loopback (a Keycloak or the test IdP) is allowed so the flow can be
 * exercised without certificates.
 */
function readSso(env: Record<string, string | undefined>, hardened: boolean): SsoConfig {
  let issuer: URL;
  try {
    issuer = new URL(env.OIDC_ISSUER ?? '');
  } catch {
    throw new ConfigurationError('OIDC_ISSUER tidak valid.');
  }
  if (issuer.search || issuer.hash || issuer.username || issuer.password)
    throw new ConfigurationError('OIDC_ISSUER harus URL issuer bersih.');
  if (
    issuer.protocol !== 'https:' &&
    !(!hardened && issuer.protocol === 'http:' && localHosts.has(issuer.hostname))
  )
    throw new ConfigurationError(
      'OIDC_ISSUER wajib https (http hanya untuk loopback pada build lokal).',
    );
  const clientId = env.OIDC_CLIENT_ID ?? '';
  if (!clientId.trim()) throw new ConfigurationError('OIDC_CLIENT_ID belum diisi.');
  const clientSecret = env.OIDC_CLIENT_SECRET ?? '';
  if (clientSecret.length < (hardened ? 32 : 16))
    throw new ConfigurationError('OIDC_CLIENT_SECRET terlalu pendek.');
  const label = (env.OIDC_LABEL ?? '').trim() || 'SSO perusahaan';
  if (label.length > 40) throw new ConfigurationError('OIDC_LABEL maksimal 40 karakter.');
  return { issuer: issuer.href.replace(/\/$/, ''), clientId, clientSecret, label };
}

/**
 * The two windows retention runs on: how long after expiry an unreplaced document is
 * archived, and how long after a missed review date the category's administrators are
 * told. Defaults of a month each; bounded so a typo cannot archive everything tonight.
 */
export function readRetentionWindows(env: Record<string, string | undefined>): {
  graceDays: number;
  overdueDays: number;
} {
  const read = (key: string, fallback: number) => {
    const raw = env[key];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 3650)
      throw new ConfigurationError(`${key} harus bilangan bulat 1..3650 (hari).`);
    return n;
  };
  return {
    graceDays: read('RETENTION_GRACE_DAYS', 30),
    overdueDays: read('RETENTION_OVERDUE_DAYS', 30),
  };
}
export function readWorkerConfig(env: Record<string, string | undefined>): { databaseUrl: string } {
  if (!isProfile(env.APP_PROFILE))
    throw new ConfigurationError(`APP_PROFILE harus salah satu dari ${PROFILES.join(', ')}.`);
  if (env.AI_PROVIDER !== 'off' && env.AI_PROVIDER !== 'weknora-local')
    throw new ConfigurationError('Worker hanya menerima AI_PROVIDER off atau weknora-local.');
  const raw = env.WORKER_DATABASE_URL ?? '';
  const u =
    env.APP_PROFILE === 'local-dev'
      ? assertLocalDatabase(raw)
      : assertDeployedDatabase(raw, env.DATABASE_PRIVATE_NETWORK === 'true');
  if (decodeURIComponent(u.username) !== 'intradocs_worker')
    throw new ConfigurationError('Worker wajib memakai role terpisah.');
  return { databaseUrl: raw };
}
