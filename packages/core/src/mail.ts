/**
 * Email as a second channel for what the bell already shows.
 *
 * Three modes, read from the environment like everything else: `off` (the default; the
 * worker retires unsent items quietly), `file` (each digest written as an .eml under a
 * private folder -- the laptop's outbox, never on a deployment), and `smtp` (a relay the
 * organisation runs, over TLS). No provider SDK: SMTP is small enough to speak directly,
 * and a relay is what every organisation already has.
 */
import { connect as tcpConnect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { ConfigurationError } from './config.ts';

export type MailConfig =
  | { mode: 'off' }
  | { mode: 'file'; dir: string; from: string }
  | {
      mode: 'smtp';
      host: string;
      port: number;
      /** `smtps` is implicit TLS on connect; `smtp` upgrades with STARTTLS (required). */
      implicitTls: boolean;
      user: string | null;
      password: string | null;
      from: string;
    };

/** `MAIL_MODE`, `SMTP_URL` (smtps://user:pass@host:465 or smtp://host:587), `MAIL_FROM`. */
export function readMailConfig(
  env: Record<string, string | undefined>,
  hardened: boolean,
): MailConfig {
  const mode = env.MAIL_MODE ?? 'off';
  if (mode === 'off') return { mode: 'off' };
  const from = (env.MAIL_FROM ?? '').trim();
  if (
    !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(from) &&
    !/^[^<>]+ <[^\s<>@]+@[^\s<>@]+>$/.test(from)
  )
    throw new ConfigurationError('MAIL_FROM harus alamat pengirim yang valid.');
  if (mode === 'file') {
    if (hardened) throw new ConfigurationError('MAIL_MODE=file hanya untuk build lokal.');
    const dir = env.MAIL_OUTBOX_DIR ?? 'var/outbox';
    if (!/^var\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(dir))
      throw new ConfigurationError('MAIL_OUTBOX_DIR harus subfolder privat var/.');
    return { mode: 'file', dir, from };
  }
  if (mode !== 'smtp')
    throw new ConfigurationError('MAIL_MODE hanya menerima off, file, atau smtp.');
  let url: URL;
  try {
    url = new URL(env.SMTP_URL ?? '');
  } catch {
    throw new ConfigurationError('SMTP_URL tidak valid.');
  }
  if (url.protocol !== 'smtp:' && url.protocol !== 'smtps:')
    throw new ConfigurationError('SMTP_URL harus smtp:// (STARTTLS) atau smtps:// (TLS).');
  if (!url.hostname) throw new ConfigurationError('SMTP_URL tidak menyebut host.');
  const implicitTls = url.protocol === 'smtps:';
  const port = url.port ? Number(url.port) : implicitTls ? 465 : 587;
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new ConfigurationError('Port SMTP tidak valid.');
  const user = url.username ? decodeURIComponent(url.username) : null;
  const password = url.password ? decodeURIComponent(url.password) : null;
  if ((user && !password) || (!user && password))
    throw new ConfigurationError('SMTP_URL: user dan password harus keduanya ada atau tidak.');
  return { mode: 'smtp', host: url.hostname, port, implicitTls, user, password, from };
}

// --- composing ------------------------------------------------------------------

export interface DigestItem {
  kind: string;
  title: string;
  documentId: string;
  slug: string;
  versionId: string;
  createdAt: string;
}
export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
}
/** The same words the bell uses (apps/web notification-kinds), kept in one place here. */
export const DIGEST_KIND_LABELS: Record<string, string> = {
  review_assigned: 'Anda ditugaskan mereview',
  review_decided: 'Review diputuskan',
  published: 'Terpublikasi',
  review_due: 'Review berkala jatuh tempo',
  expired: 'Kedaluwarsa',
  feedback: 'Masukan pembaca baru',
  index_failed: 'Indeks gagal — publikasi diulang otomatis',
  archived: 'Diarsipkan otomatis — kedaluwarsa tanpa pembaruan',
  review_overdue: 'Review terlewat — perlu tindak lanjut',
};
const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

/**
 * One mail for one person. Titles are the portal's own data and are escaped; links go
 * to the reader, which applies the person's access on arrival -- a forwarded mail opens
 * nothing for anyone else.
 */
export function composeDigest(
  person: { email: string; name: string },
  items: DigestItem[],
  appUrl: string,
): Mail {
  const base = appUrl.replace(/\/$/, '');
  const href = (i: DigestItem) => `${base}/dokumen/${i.documentId}/${encodeURIComponent(i.slug)}`;
  const label = (i: DigestItem) => DIGEST_KIND_LABELS[i.kind] ?? 'Pemberitahuan';
  const first = items[0];
  const subject =
    items.length === 1 && first
      ? `[IntraDocs] ${label(first)}: ${first.title}`
      : `[IntraDocs] ${items.length} pemberitahuan baru`;
  const lines = items.map((i) => `- ${label(i)}: ${i.title}\n  ${href(i)}`);
  const text =
    `Halo ${person.name},\n\n` +
    `Ada ${items.length} hal baru di IntraDocs:\n\n${lines.join('\n')}\n\n` +
    `Semua pemberitahuan: ${base}/notifikasi\n` +
    `Berhenti menerima email ini: ${base}/pengaturan\n`;
  const rows = items
    .map(
      (i) =>
        `<li style="margin:0 0 10px"><strong>${escapeHtml(label(i))}</strong><br>` +
        `<a href="${escapeHtml(href(i))}">${escapeHtml(i.title)}</a></li>`,
    )
    .join('');
  const html =
    `<!doctype html><html lang="id"><body style="font:15px/1.5 system-ui,sans-serif;color:#1c2333;max-width:36em;margin:2em auto;padding:0 1em">` +
    `<p>Halo ${escapeHtml(person.name)},</p><p>Ada ${items.length} hal baru di IntraDocs:</p>` +
    `<ul style="padding-left:1.2em">${rows}</ul>` +
    `<p style="color:#5b6472;font-size:13px">` +
    `<a href="${escapeHtml(base)}/notifikasi">Semua pemberitahuan</a> · ` +
    `<a href="${escapeHtml(base)}/pengaturan">Berhenti menerima email ini</a></p>` +
    `</body></html>`;
  return { to: person.email, subject, text, html };
}

// --- transports -----------------------------------------------------------------

export interface MailTransport {
  send(mail: Mail): Promise<void>;
}

const CRLF = '\r\n';
/** RFC 2047 for the non-ASCII a subject or a name may carry. */
const encodeWord = (s: string) =>
  /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
const wrap76 = (b64: string) => b64.replace(/(.{76})/g, '$1\r\n');
/** The RFC 5322 message, multipart/alternative, everything base64 so no line is unsafe. */
export function renderMessage(mail: Mail, from: string, date = new Date()): string {
  const boundary = `=_intradocs_${date.getTime().toString(36)}`;
  const messageId = `<${date.getTime().toString(36)}.${Math.random().toString(36).slice(2)}@intradocs>`;
  const part = (type: string, body: string) =>
    `--${boundary}${CRLF}Content-Type: ${type}; charset=UTF-8${CRLF}Content-Transfer-Encoding: base64${CRLF}${CRLF}` +
    wrap76(Buffer.from(body, 'utf8').toString('base64')) +
    CRLF;
  return (
    [
      `From: ${from}`,
      `To: ${mail.to}`,
      `Subject: ${encodeWord(mail.subject)}`,
      `Date: ${date.toUTCString()}`,
      `Message-ID: ${messageId}`,
      'MIME-Version: 1.0',
      'Auto-Submitted: auto-generated',
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
    ].join(CRLF) +
    CRLF +
    CRLF +
    part('text/plain', mail.text) +
    part('text/html', mail.html) +
    `--${boundary}--${CRLF}`
  );
}

/** Writes each mail as an .eml the operator can open; the laptop's outbox. */
export class FileMailTransport implements MailTransport {
  private readonly dir: string;
  private readonly from: string;
  private readonly fs: {
    mkdir(p: string, o: { recursive: true }): Promise<unknown>;
    writeFile(p: string, data: string): Promise<void>;
  };
  constructor(dir: string, from: string, fs: FileMailTransport['fs']) {
    this.dir = dir;
    this.from = from;
    this.fs = fs;
  }
  async send(mail: Mail): Promise<void> {
    await this.fs.mkdir(this.dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const who = mail.to.replace(/[^a-z0-9]+/gi, '_');
    await this.fs.writeFile(`${this.dir}/${stamp}-${who}.eml`, renderMessage(mail, this.from));
  }
}

/**
 * Just enough SMTP: EHLO, STARTTLS (mandatory on a plain connection -- a relay that
 * cannot upgrade is refused, credentials never cross in the clear), AUTH PLAIN or
 * LOGIN, one message, QUIT. Dot-stuffed, bounded, and it never logs the conversation.
 */
export class SmtpMailTransport implements MailTransport {
  private readonly c: Extract<MailConfig, { mode: 'smtp' }>;
  private readonly timeoutMs: number;
  constructor(c: Extract<MailConfig, { mode: 'smtp' }>, timeoutMs = 15000) {
    this.c = c;
    this.timeoutMs = timeoutMs;
  }
  async send(mail: Mail): Promise<void> {
    const { c } = this;
    const address = (s: string) => /<([^>]+)>/.exec(s)?.[1] ?? s;
    let socket: Socket = c.implicitTls
      ? tlsConnect({ host: c.host, port: c.port, servername: c.host })
      : tcpConnect({ host: c.host, port: c.port });
    const session = new SmtpSession(socket, this.timeoutMs);
    try {
      await session.expect(220);
      await session.command(`EHLO intradocs`, 250);
      if (!c.implicitTls) {
        if (!session.extensions.has('STARTTLS'))
          throw new Error('Relay SMTP tidak menawarkan STARTTLS; koneksi tanpa TLS ditolak.');
        await session.command('STARTTLS', 220);
        socket = tlsConnect({ socket, servername: c.host });
        session.upgrade(socket);
        session.extensions.clear();
        await session.command('EHLO intradocs', 250);
      }
      if (c.user && c.password) {
        if (session.extensions.has('AUTH PLAIN') || session.auth.includes('PLAIN')) {
          const token = Buffer.from(`\0${c.user}\0${c.password}`).toString('base64');
          await session.command(`AUTH PLAIN ${token}`, 235);
        } else if (session.auth.includes('LOGIN')) {
          await session.command('AUTH LOGIN', 334);
          await session.command(Buffer.from(c.user).toString('base64'), 334);
          await session.command(Buffer.from(c.password).toString('base64'), 235);
        } else throw new Error('Relay SMTP tidak menawarkan AUTH PLAIN/LOGIN.');
      }
      await session.command(`MAIL FROM:<${address(c.from)}>`, 250);
      await session.command(`RCPT TO:<${address(mail.to)}>`, [250, 251]);
      await session.command('DATA', 354);
      const body = renderMessage(mail, c.from).replace(/^\./gm, '..');
      await session.command(`${body}${CRLF}.`, 250);
      await session.command('QUIT', 221).catch(() => undefined);
    } finally {
      session.close();
    }
  }
}

class SmtpSession {
  extensions = new Set<string>();
  auth: string[] = [];
  private buffer = '';
  private waiters: Array<(line: string[]) => void> = [];
  private failed: Error | null = null;
  private socket: Socket;
  private readonly timeoutMs: number;
  constructor(socket: Socket, timeoutMs: number) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.attach(socket);
  }
  private attach(socket: Socket) {
    socket.setEncoding('utf8');
    socket.setTimeout(this.timeoutMs, () => this.fail(new Error('SMTP timeout')));
    socket.on('data', (chunk: string) => this.feed(chunk));
    socket.on('error', (e) => this.fail(e));
    socket.on('close', () => this.fail(new Error('SMTP connection closed')));
  }
  upgrade(socket: Socket) {
    this.socket.removeAllListeners('data');
    this.socket.removeAllListeners('close');
    this.socket.removeAllListeners('error');
    this.socket = socket;
    this.buffer = '';
    this.attach(socket);
  }
  private fail(e: Error) {
    if (this.failed) return;
    this.failed = e;
    for (const w of this.waiters.splice(0)) w([`599 ${e.message}`]);
  }
  private feed(chunk: string) {
    this.buffer += chunk;
    if (this.buffer.length > 65536) return this.fail(new Error('SMTP reply too long'));
    // A reply is complete at a line "NNN text" (space after the code); "NNN-text" continues.
    const lines = this.buffer.split(CRLF);
    let end = -1;
    for (let i = 0; i < lines.length - 1; i++) if (/^\d{3}(?: |$)/.test(lines[i]!)) end = i;
    if (end < 0) return;
    const reply = lines.slice(0, end + 1);
    this.buffer = lines.slice(end + 1).join(CRLF);
    this.waiters.shift()?.(reply);
  }
  private next(): Promise<string[]> {
    if (this.failed) return Promise.resolve([`599 ${this.failed.message}`]);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
  async expect(codes: number | number[]): Promise<string[]> {
    const reply = await this.next();
    const code = Number(reply[reply.length - 1]!.slice(0, 3));
    const ok = Array.isArray(codes) ? codes.includes(code) : codes === code;
    if (!ok) throw new Error(`SMTP ${code}: ${reply[reply.length - 1]!.slice(4, 120)}`);
    for (const line of reply) {
      const ext = line.slice(4).trim().toUpperCase();
      if (ext.startsWith('AUTH ')) this.auth = ext.slice(5).split(/\s+/);
      this.extensions.add(ext);
    }
    return reply;
  }
  command(line: string, codes: number | number[]): Promise<string[]> {
    if (this.failed) return Promise.reject(this.failed);
    this.socket.write(line + CRLF);
    return this.expect(codes);
  }
  close() {
    this.socket.destroy();
  }
}

// --- the worker step ------------------------------------------------------------

export interface DigestRepository {
  /** One person's unsent items, or null when nobody is due. */
  claim(): Promise<{
    userId: string;
    email: string;
    name: string;
    items: Array<DigestItem & { id: string }>;
  } | null>;
  settle(ids: string[], sent: boolean): Promise<void>;
}
/**
 * Sends at most `limit` digests: claim one person, compose, send, settle. A failed send
 * counts an attempt and leaves the items for the next round; the repository gives up
 * after a few. Returns how many mails went out.
 */
export async function processEmailDigests(deps: {
  repository: DigestRepository;
  transport: MailTransport;
  appUrl: string;
  limit?: number;
  log?: (message: string) => void;
}): Promise<number> {
  let sent = 0;
  for (let i = 0; i < (deps.limit ?? 20); i++) {
    const digest = await deps.repository.claim();
    if (!digest || digest.items.length === 0) break;
    const ids = digest.items.map((item) => item.id);
    try {
      await deps.transport.send(
        composeDigest({ email: digest.email, name: digest.name }, digest.items, deps.appUrl),
      );
      await deps.repository.settle(ids, true);
      sent++;
    } catch (e) {
      await deps.repository.settle(ids, false);
      // The address is the person's; the reason is enough for an operator.
      deps.log?.(`Email digest tertunda: ${e instanceof Error ? e.message : 'gagal'}`);
      break;
    }
  }
  return sent;
}
