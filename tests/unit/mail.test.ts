import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Socket } from 'node:net';
import { ConfigurationError } from '../../packages/core/src/config.ts';
import {
  FileMailTransport,
  SmtpMailTransport,
  composeDigest,
  processEmailDigests,
  readMailConfig,
  renderMessage,
  type DigestItem,
} from '../../packages/core/src/mail.ts';

const from = 'IntraDocs <noreply@intradocs.example.test>';

test('mail is off unless configured, and a deployment refuses the file outbox', () => {
  assert.deepEqual(readMailConfig({}, true), { mode: 'off' });
  assert.deepEqual(readMailConfig({ MAIL_MODE: 'file', MAIL_FROM: from }, false), {
    mode: 'file',
    dir: 'var/outbox',
    from,
  });
  assert.throws(
    () => readMailConfig({ MAIL_MODE: 'file', MAIL_FROM: from }, true),
    ConfigurationError,
  );
  assert.throws(
    () =>
      readMailConfig({ MAIL_MODE: 'file', MAIL_FROM: from, MAIL_OUTBOX_DIR: 'public/x' }, false),
    ConfigurationError,
  );
  assert.throws(
    () => readMailConfig({ MAIL_MODE: 'smtp', MAIL_FROM: 'nope' }, true),
    ConfigurationError,
  );
  assert.throws(
    () => readMailConfig({ MAIL_MODE: 'sendgrid', MAIL_FROM: from }, true),
    ConfigurationError,
  );
});

test('SMTP_URL: smtps is implicit TLS on 465, smtp is STARTTLS on 587, credentials come as a pair', () => {
  const a = readMailConfig(
    { MAIL_MODE: 'smtp', MAIL_FROM: from, SMTP_URL: 'smtps://u%40x:p%23w@relay.example.test' },
    true,
  );
  assert.equal(a.mode, 'smtp');
  if (a.mode !== 'smtp') return;
  assert.deepEqual(
    [a.host, a.port, a.implicitTls, a.user, a.password],
    ['relay.example.test', 465, true, 'u@x', 'p#w'],
  );
  const b = readMailConfig(
    { MAIL_MODE: 'smtp', MAIL_FROM: from, SMTP_URL: 'smtp://relay.example.test' },
    true,
  );
  if (b.mode !== 'smtp') return assert.fail();
  assert.deepEqual([b.port, b.implicitTls, b.user], [587, false, null]);
  assert.throws(
    () =>
      readMailConfig(
        { MAIL_MODE: 'smtp', MAIL_FROM: from, SMTP_URL: 'smtp://user@relay.example.test' },
        true,
      ),
    ConfigurationError,
  );
  assert.throws(
    () =>
      readMailConfig(
        { MAIL_MODE: 'smtp', MAIL_FROM: from, SMTP_URL: 'http://relay.example.test' },
        true,
      ),
    ConfigurationError,
  );
});

const items: DigestItem[] = [
  {
    kind: 'review_assigned',
    title: 'SOP <Backup> & "Restore"',
    documentId: 'd1',
    slug: 'sop-backup',
    versionId: 'v1',
    createdAt: '2026-09-21T00:00:00Z',
  },
  {
    kind: 'feedback',
    title: 'Katalog API',
    documentId: 'd2',
    slug: 'katalog api',
    versionId: 'v2',
    createdAt: '2026-09-21T00:01:00Z',
  },
];

test("a digest names each item with the bell's words, links into the reader, and escapes titles", () => {
  const one = composeDigest(
    { email: 'siti@example.test', name: 'Siti' },
    items.slice(0, 1),
    'https://intradocs.example.test/',
  );
  assert.equal(one.subject, '[IntraDocs] Anda ditugaskan mereview: SOP <Backup> & "Restore"');
  assert(one.text.includes('https://intradocs.example.test/dokumen/d1/sop-backup'));
  assert(one.html.includes('SOP &lt;Backup&gt; &amp; &quot;Restore&quot;'));
  assert(!one.html.includes('<Backup>'));
  const two = composeDigest(
    { email: 'siti@example.test', name: 'Siti' },
    items,
    'https://intradocs.example.test',
  );
  assert.equal(two.subject, '[IntraDocs] 2 pemberitahuan baru');
  assert(two.text.includes('/dokumen/d2/katalog%20api'));
  assert(two.text.includes('/pengaturan'), 'a way to stop the mail is in every mail');
});

test('the rendered message is plain 7-bit MIME with both parts', () => {
  const mail = composeDigest(
    { email: 'siti@example.test', name: 'Siti' },
    items,
    'https://intradocs.example.test',
  );
  const raw = renderMessage(mail, from, new Date('2026-09-21T03:00:00Z'));
  assert(
    raw.startsWith(
      `From: ${from}\r\nTo: siti@example.test\r\nSubject: [IntraDocs] 2 pemberitahuan baru\r\n`,
    ),
  );
  assert(raw.includes('Content-Type: text/plain; charset=UTF-8'));
  assert(raw.includes('Content-Type: text/html; charset=UTF-8'));
  assert(raw.includes('Auto-Submitted: auto-generated'));
  // Every line is ASCII and short enough for any relay.
  for (const line of raw.split('\r\n')) {
    assert(/^[\x00-\x7f]*$/.test(line), 'non-ASCII line');
    assert(line.length <= 998);
  }
  const subject = renderMessage({ ...mail, subject: 'Kedaluwarsa — cek' }, from)
    .split('\r\n')
    .find((l) => l.startsWith('Subject:'))!;
  assert(subject.startsWith('Subject: =?UTF-8?B?'), 'non-ASCII subject is RFC 2047 encoded');
});

test('the file transport writes one .eml per mail under the outbox', async () => {
  const written: Array<[string, string]> = [];
  const t = new FileMailTransport('var/outbox', from, {
    mkdir: async () => undefined,
    writeFile: async (p, d) => void written.push([p, d]),
  });
  await t.send(
    composeDigest({ email: 'siti@example.test', name: 'Siti' }, items, 'http://localhost:3000'),
  );
  assert.equal(written.length, 1);
  assert(written[0]![0].startsWith('var/outbox/'));
  assert(written[0]![0].endsWith('-siti_example_test.eml'));
  assert(written[0]![1].includes('To: siti@example.test'));
});

/** A relay that speaks just enough SMTP to accept one message, recording what it saw. */
function fakeRelay(opts: { starttls: boolean; auth: string | null; rejectRcpt?: boolean }) {
  const seen: string[] = [];
  let message = '';
  const server = createServer((socket: Socket) => {
    let inData = false;
    socket.write('220 relay.test ESMTP\r\n');
    socket.on('data', (chunk) => {
      const text = chunk.toString();
      if (inData) {
        message += text;
        if (message.endsWith('\r\n.\r\n')) {
          inData = false;
          socket.write('250 queued\r\n');
        }
        return;
      }
      for (const line of text.split('\r\n').filter(Boolean)) {
        seen.push(line);
        if (line.startsWith('EHLO')) {
          const ext = [
            '250-relay.test',
            ...(opts.starttls ? ['250-STARTTLS'] : []),
            ...(opts.auth ? [`250-AUTH ${opts.auth}`] : []),
            '250 8BITMIME',
          ];
          socket.write(ext.join('\r\n') + '\r\n');
        } else if (line === 'STARTTLS') socket.write('454 TLS not available\r\n');
        else if (line.startsWith('AUTH PLAIN')) socket.write('235 ok\r\n');
        else if (line.startsWith('MAIL FROM')) socket.write('250 ok\r\n');
        else if (line.startsWith('RCPT TO'))
          socket.write(opts.rejectRcpt ? '550 no such user\r\n' : '250 ok\r\n');
        else if (line === 'DATA') {
          inData = true;
          socket.write('354 go\r\n');
        } else if (line === 'QUIT') {
          socket.write('221 bye\r\n');
          socket.end();
        } else socket.write('500 what\r\n');
      }
    });
  });
  return new Promise<{ port: number; seen: string[]; message: () => string; close: () => void }>(
    (resolve) =>
      server.listen(0, '127.0.0.1', () =>
        resolve({
          port: (server.address() as { port: number }).port,
          seen,
          message: () => message,
          close: () => server.close(),
        }),
      ),
  );
}

test('a plain SMTP relay without STARTTLS is refused before any credential is sent', async () => {
  const relay = await fakeRelay({ starttls: false, auth: 'PLAIN' });
  try {
    const t = new SmtpMailTransport(
      {
        mode: 'smtp',
        host: '127.0.0.1',
        port: relay.port,
        implicitTls: false,
        user: 'u',
        password: 'p',
        from,
      },
      3000,
    );
    await assert.rejects(
      () => t.send({ to: 'siti@example.test', subject: 's', text: 't', html: '<p>t</p>' }),
      /STARTTLS/,
    );
    assert(!relay.seen.some((l) => l.startsWith('AUTH')), 'no AUTH on a clear connection');
    assert(!relay.seen.some((l) => l.startsWith('MAIL FROM')));
  } finally {
    relay.close();
  }
});

test('a relay that advertises STARTTLS but cannot upgrade is refused too', async () => {
  // (Implicit-TLS and a real upgrade need a certificate the fake does not have; the
  // command sequence past STARTTLS is covered against a real relay in a deployment's
  // ops:preflight, not here.)
  const relay = await fakeRelay({ starttls: true, auth: 'PLAIN', rejectRcpt: true });
  try {
    const t = new SmtpMailTransport(
      {
        mode: 'smtp',
        host: '127.0.0.1',
        port: relay.port,
        implicitTls: false,
        user: null,
        password: null,
        from,
      },
      3000,
    );
    await assert.rejects(
      () => t.send({ to: 'x@example.test', subject: 's', text: 't', html: '<p>t</p>' }),
      /454/,
    );
    assert(!relay.seen.some((l) => l.startsWith('MAIL FROM')), 'nothing is sent in the clear');
  } finally {
    relay.close();
  }
});

test('the worker step sends one digest per person, settles it, and stops on a failing relay', async () => {
  const queue = [
    {
      userId: 'a',
      email: 'a@example.test',
      name: 'A',
      items: [
        { ...items[0]!, id: 'n1' },
        { ...items[1]!, id: 'n2' },
      ],
    },
    { userId: 'b', email: 'b@example.test', name: 'B', items: [{ ...items[0]!, id: 'n3' }] },
  ];
  const settled: Array<[string[], boolean]> = [];
  const sent: string[] = [];
  const repository = {
    claim: async () => queue.shift() ?? null,
    settle: async (ids: string[], ok: boolean) => void settled.push([ids, ok]),
  };
  const n = await processEmailDigests({
    repository,
    transport: { send: async (m) => void sent.push(m.to) },
    appUrl: 'http://localhost:3000',
  });
  assert.equal(n, 2);
  assert.deepEqual(sent, ['a@example.test', 'b@example.test']);
  assert.deepEqual(settled, [
    [['n1', 'n2'], true],
    [['n3'], true],
  ]);
  // A relay that fails: one attempt counted, nothing else tried this round.
  queue.push(
    { userId: 'c', email: 'c@example.test', name: 'C', items: [{ ...items[0]!, id: 'n4' }] },
    { userId: 'd', email: 'd@example.test', name: 'D', items: [{ ...items[0]!, id: 'n5' }] },
  );
  settled.length = 0;
  const logs: string[] = [];
  const m = await processEmailDigests({
    repository,
    transport: {
      send: async () => {
        throw new Error('SMTP 421: try later');
      },
    },
    appUrl: 'http://localhost:3000',
    log: (l) => void logs.push(l),
  });
  assert.equal(m, 0);
  assert.deepEqual(settled, [[['n4'], false]]);
  assert.equal(queue.length, 1, 'the next person waits for the next round');
  assert.match(logs[0]!, /421/);
});
