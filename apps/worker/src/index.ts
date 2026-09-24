import path from 'node:path';
import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { PgBoss } from 'pg-boss';
import { readRetentionWindows, readWorkerConfig } from '@intradocs/core/config';
import { createBlobStore } from '@intradocs/core/storage';
import { processPublication } from '@intradocs/core/workflow';
import { readAiConfig } from '@intradocs/core/ai-config';
import { WeknoraClient } from '@intradocs/core/weknora';
import { processRagExport, sweepRagOrphans } from '@intradocs/core/rag';
import { processEmailDigests } from '@intradocs/core/mail';
import { PostgresPublicationRepository } from './publication.ts';
import { PostgresDigestRepository, createMailTransport } from './mail.ts';
import { syncTaIndex } from './ta-index.ts';
import { PostgresRagExportRepository, WeknoraIndexTarget } from './rag-export.ts';

const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

async function start() {
  const { databaseUrl: connectionString, storage: storageConfig } = readWorkerConfig(process.env);
  const root = process.env.INTRADOCS_ROOT;
  if (!root) throw new Error('Worker requires INTRADOCS_ROOT.');
  const pool = new Pool({ connectionString, max: 3, connectionTimeoutMillis: 5000 });
  const boss = new PgBoss({ connectionString, schema: 'jobs', createSchema: false });
  const storage = createBlobStore(storageConfig, root);
  const repository = new PostgresPublicationRepository(pool);
  // AI stays off unless explicitly configured; with it off no exporter, client or
  // outbound request exists at all, and publication keeps working unchanged.
  const ai = readAiConfig(process.env);
  // The sweep lists the whole knowledge base, so it runs on its own slow cadence
  // rather than on every export cycle.
  let sweepDue = Date.now();
  const rag =
    ai.retrieval === 'weknora-local' && ai.weknora
      ? {
          repository: new PostgresRagExportRepository(pool),
          index: new WeknoraIndexTarget(new WeknoraClient(ai.weknora)),
        }
      : null;
  // Email is a second channel for the bell. With MAIL_MODE=off nothing is built and
  // unsent items are retired after a day, so switching mail on later does not release
  // a backlog of stale mail.
  const mail = createMailTransport(process.env, path.resolve(root));
  const digests = mail ? new PostgresDigestRepository(pool) : null;
  let digestDue = Date.now();
  // Technology Architecture cards go to their own knowledge base, when one is set up
  // (pnpm weknora:ta-setup); without it the TA pages work and search is exact-match only.
  const taKnowledgeBase = process.env.WEKNORA_TA_KNOWLEDGE_BASE_ID ?? '';
  const taIndex =
    ai.weknora && taKnowledgeBase
      ? new WeknoraClient({ ...ai.weknora, knowledgeBaseId: taKnowledgeBase })
      : null;
  let taDue = Date.now();
  boss.on('error', () => console.error('Antrean worker gagal; periksa PostgreSQL.'));
  pool.on('error', () => console.error('Koneksi worker gagal.'));
  await boss.start();
  await boss.createQueue('review-reminders');
  const retention = readRetentionWindows(process.env);
  await boss.work('review-reminders', async () => {
    await pool.query('SELECT app.enqueue_review_reminders()');
    // The policy pass: archive what expired and was not replaced within the grace
    // window, escalate reviews overdue past the other. Counts are the only output.
    const { rows } = await pool.query<{ archived: number; escalated: number }>(
      'SELECT * FROM app.apply_retention($1,$2)',
      [retention.graceDays, retention.overdueDays],
    );
    const r = rows[0];
    if (r && (r.archived > 0 || r.escalated > 0))
      console.log(`Retensi: ${r.archived} diarsipkan, ${r.escalated} eskalasi review.`);
    // Search wording expires after 30 days while the counts stay, so the KPI tiles keep
    // working without the phrasing accumulating indefinitely.
    await pool.query('SELECT app.prune_search_queries()');
  });
  await boss.schedule('review-reminders', '0 * * * *');
  await boss.send('review-reminders', {}, { singletonKey: 'hourly-reminders' });
  let stopping = false;
  let running = false;
  async function tick() {
    if (running || stopping) return;
    running = true;
    try {
      // Bounded draining; the SQL lease/outbox remains authoritative after a crash.
      for (let i = 0; i < 10 && !stopping; i++) {
        if (
          !(await processPublication({ repository, read: (key, hash) => storage.read(key, hash) }))
        )
          break;
      }
      if (rag) {
        // Reconciliation is the only enqueue path, so revoke, expiry and supersede all
        // reach WeKnora through one code path. A failure here must never stop publication.
        try {
          await rag.repository.reconcile();
          for (let i = 0; i < 10 && !stopping; i++) {
            if (
              !(await processRagExport({
                repository: rag.repository,
                index: rag.index,
                read: (key, hash) => storage.read(key, hash),
                digest: sha256Hex,
              }))
            )
              break;
          }
          // Records whose version was deleted outright never produce a removal job,
          // because the cascade takes the mapping with the version. Sweep them here.
          if (sweepDue <= Date.now()) {
            sweepDue = Date.now() + 600000;
            const swept = await sweepRagOrphans({ repository: rag.repository, index: rag.index });
            if (swept.removed > 0)
              console.log(`Menyapu ${swept.removed} record WeKnora tanpa pemilik.`);
          }
        } catch {
          console.error('Ekspor RAG tertunda; antrean mempertahankan status dan retry.');
        }
      }
      if (taIndex && taDue <= Date.now()) {
        taDue = Date.now() + 30000;
        try {
          const n = await syncTaIndex(pool, taIndex);
          if (n > 0) console.log(`Indeks arsitektur: ${n} kartu elemen diperbarui.`);
        } catch {
          console.error('Indeks arsitektur tertunda; dicoba lagi pada putaran berikutnya.');
        }
      }
      if (digestDue <= Date.now()) {
        digestDue = Date.now() + 60000;
        try {
          if (digests && mail) {
            const sent = await processEmailDigests({
              repository: digests,
              transport: mail.transport,
              appUrl: mail.appUrl,
              log: (m) => console.error(m),
            });
            if (sent > 0) console.log(`Mengirim ${sent} email ringkasan.`);
          }
          await pool.query('SELECT app.retire_stale_email($1::interval)', [
            digests ? '7 days' : '1 day',
          ]);
        } catch {
          console.error('Email ringkasan tertunda; item menunggu putaran berikutnya.');
        }
      }
      await pool.query(
        "INSERT INTO app.worker_status(name,last_seen) VALUES('intradocs-worker',now()) ON CONFLICT(name) DO UPDATE SET last_seen=excluded.last_seen",
      );
    } catch {
      console.error('Publikasi tertunda; outbox mempertahankan status dan retry.');
    } finally {
      running = false;
    }
  }
  await tick();
  const timer = setInterval(() => void tick(), 2000);
  async function stop() {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    while (running) await new Promise((resolve) => setTimeout(resolve, 50));
    await boss.stop();
    await pool.end();
  }
  process.on('SIGINT', () => void stop().then(() => process.exit(0)));
  process.on('SIGTERM', () => void stop().then(() => process.exit(0)));
  console.log(
    rag
      ? 'Worker M4 siap: publikasi lexical, retry outbox, pengingat review, dan ekspor WeKnora.'
      : 'Worker M3 siap: publikasi lexical, retry outbox, dan pengingat review. AI off.',
  );
}
start().catch((error: unknown) => {
  console.error('Worker tidak dapat dimulai.', {
    code: (error as { code?: string }).code,
    message:
      error instanceof Error
        ? error.message.replace(/postgres(?:ql)?:\/\/[^\s]+/g, '[database]')
        : 'Periksa layanan lokal.',
  });
  process.exit(1);
});
