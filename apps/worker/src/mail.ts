import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Pool } from 'pg';
import {
  FileMailTransport,
  SmtpMailTransport,
  readMailConfig,
  type DigestItem,
  type DigestRepository,
  type MailTransport,
} from '@intradocs/core/mail';
import { isProfile } from '@intradocs/core/config';

/** The two SECURITY DEFINER functions from migration 041; nothing else is readable. */
export class PostgresDigestRepository implements DigestRepository {
  constructor(
    private readonly pool: Pool,
    /** A burst of events becomes one mail: wait this long after the newest item. */
    private readonly settleAfter = '2 minutes',
    private readonly maxAttempts = 5,
  ) {}
  async claim() {
    const { rows } = await this.pool.query<{
      user_id: string;
      email: string;
      name: string;
      items: Array<DigestItem & { id: string }> | null;
    }>('SELECT * FROM app.claim_email_digest($1::interval,$2)', [
      this.settleAfter,
      this.maxAttempts,
    ]);
    const r = rows[0];
    if (!r || !r.items) return null;
    return { userId: r.user_id, email: r.email, name: r.name, items: r.items };
  }
  async settle(ids: string[], sent: boolean) {
    await this.pool.query('SELECT app.settle_email_digest($1::uuid[],$2)', [ids, sent]);
  }
}

/** null when MAIL_MODE=off: no transport exists, so nothing can send by accident. */
export function createMailTransport(
  env: NodeJS.ProcessEnv,
  root: string,
): { transport: MailTransport; appUrl: string } | null {
  const hardened = isProfile(env.APP_PROFILE) && env.APP_PROFILE !== 'local-dev';
  const c = readMailConfig(env, hardened);
  if (c.mode === 'off') return null;
  const appUrl = env.APP_URL ?? '';
  if (!/^https?:\/\//.test(appUrl)) throw new Error('Worker needs APP_URL to link digests.');
  if (c.mode === 'file')
    return {
      transport: new FileMailTransport(path.resolve(root, c.dir), c.from, { mkdir, writeFile }),
      appUrl,
    };
  return { transport: new SmtpMailTransport(c), appUrl };
}
