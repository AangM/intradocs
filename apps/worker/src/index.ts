import path from 'node:path';
import { Pool } from 'pg';
import { PgBoss } from 'pg-boss';
import { readWorkerConfig } from '@intradocs/core/config';
import { LocalBlobStore } from '@intradocs/core/storage';
import { processPublication } from '@intradocs/core/workflow';
import { PostgresPublicationRepository } from './publication.ts';

async function start() {
  const { databaseUrl: connectionString } = readWorkerConfig(process.env);
  const root = process.env.INTRADOCS_ROOT;
  const relative = process.env.STORAGE_ROOT ?? 'var/storage';
  if (!root || !/^var\/[A-Za-z0-9_/-]+$/.test(relative) || relative.includes('..'))
    throw new Error('Worker requires a private local storage directory.');
  const pool = new Pool({ connectionString, max: 3, connectionTimeoutMillis: 5000 });
  const boss = new PgBoss({ connectionString, schema: 'jobs', createSchema: false });
  const storage = new LocalBlobStore(path.resolve(root, relative));
  const repository = new PostgresPublicationRepository(pool);
  boss.on('error', () => console.error('Antrean worker gagal; periksa PostgreSQL.'));
  pool.on('error', () => console.error('Koneksi worker gagal.'));
  await boss.start();
  await boss.createQueue('review-reminders');
  await boss.work('review-reminders', async () => {
    await pool.query('SELECT app.enqueue_review_reminders()');
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
  console.log('Worker M3 siap: publikasi lexical, retry outbox, dan pengingat review. AI off.');
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
