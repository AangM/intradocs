// Q4 evaluation. Runs the gold set through the real HTTP endpoint as the real actors, so
// what is measured is the product's behaviour and not a library call with permissions
// stubbed out. Requires pnpm dev running and AI_PROVIDER=weknora-local.
//
// Prints a report and exits non-zero when a security expectation fails. Recall is
// reported, never enforced: a threshold invented here would be a number about this
// fixture corpus, not about the product.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';
import { ROOT, loadLocalEnv, localAdminUrl, reportFailure } from './shared.ts';
import { GOLD, GOLD_COUNTS, type GoldQuestion } from '../tests/rag/gold-questions.ts';
import { NO_DIRECT_ANSWER_MESSAGE } from '../packages/core/src/rag-messages.ts';
import type { DemoAccount } from './seed.ts';

interface Outcome {
  q: GoldQuestion;
  citedDocs: string[];
  leaked: string[];
  hit: boolean;
  rank: number | null;
  abstained: boolean;
  /** --chat only: sources were found but WeKnora's pipeline answered with the fixed fallback. */
  fellBack: boolean;
  ms: number;
}

async function main(): Promise<void> {
  loadLocalEnv();
  if (process.env.AI_PROVIDER !== 'weknora-local')
    throw new Error('Aktifkan AI_PROVIDER=weknora-local sebelum menjalankan evaluasi.');
  // Default: /api/rag/search, retrieval only, seconds per run. --chat: /api/rag/chat, so the
  // answering model and WeKnora's rerank/fallback stages are measured too; minutes per run.
  const chat = process.argv.includes('--chat');
  const base = process.env.APP_URL!;
  const admin = new Pool({ connectionString: localAdminUrl(), max: 1 });
  const accounts = JSON.parse(
    await readFile(path.join(ROOT, 'var/demo-accounts.json'), 'utf8'),
  ) as DemoAccount[];

  // One session per actor: the login limiter allows five attempts a minute and the gold
  // set asks far more questions than that.
  const sessions = new Map<string, string>();
  async function session(actorId: string): Promise<string> {
    const cached = sessions.get(actorId);
    if (cached) return cached;
    await admin.query('DELETE FROM auth."rateLimit"');
    const a = accounts.find((x) => x.id === actorId)!;
    const r = await fetch(base + '/api/auth/sign-in/email', {
      method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: a.email, password: a.password }),
    });
    if (!r.ok) throw new Error(`Login ${a.email} gagal: ${r.status}`);
    const cookie = r.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
    sessions.set(actorId, cookie);
    return cookie;
  }

  const outcomes: Outcome[] = [];
  // Locator quality: a citation with an anchor was found verbatim in the version's
  // Markdown; one without is shown but cannot be jumped to. Chunking changes move this.
  let anchored = 0;
  let citedTotal = 0;
  for (const q of GOLD) {
    const cookie = await session(q.actor);
    const started = Date.now();
    const response = await fetch(base + (chat ? '/api/rag/chat' : '/api/rag/search'), {
      method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ question: q.question }),
    });
    const ms = Date.now() - started;
    if (!response.ok)
      throw new Error(`Pertanyaan ${q.id} ditolak dengan status ${response.status}`);
    const body = (await response.json()) as {
      citations?: Array<{ documentId: string; anchor: string | null }>;
      answer?: string;
    };
    const citations = body.citations ?? [];
    const fellBack =
      chat && citations.length > 0 && (body.answer ?? '').trim() === NO_DIRECT_ANSWER_MESSAGE;
    anchored += citations.filter((c) => c.anchor).length;
    citedTotal += citations.length;
    // Rank by first appearance, deduplicated: several chunks of one document are one hit.
    const citedDocs: string[] = [];
    for (const c of citations) if (!citedDocs.includes(c.documentId)) citedDocs.push(c.documentId);
    const top5 = citedDocs.slice(0, 5);
    const forbidden = q.forbidden ?? [];
    outcomes.push({
      q,
      citedDocs,
      leaked: citedDocs.filter((d) => forbidden.includes(d)),
      hit: q.gold.length > 0 && q.gold.every((g) => top5.includes(g)),
      rank: q.gold.length === 1 ? top5.indexOf(q.gold[0]!) + 1 || null : null,
      abstained: citations.length === 0,
      fellBack,
      ms,
    });
  }
  await admin.end();

  const by = (k: GoldQuestion['kind']) => outcomes.filter((o) => o.q.kind === k);
  const answerable = by('answerable');
  const recallHits = answerable.filter((o) => o.hit).length;
  const recall = (recallHits / answerable.length) * 100;
  const leaks = outcomes.filter((o) => o.leaked.length > 0);
  const noEvidence = by('no-evidence');
  const abstained = noEvidence.filter((o) => o.abstained).length;
  const latencies = outcomes.map((o) => o.ms).sort((a, b) => a - b);
  const p = (q: number) =>
    latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * q))];

  console.log(
    `\nQ4 — ${GOLD_COUNTS.total} pertanyaan berlabel pada corpus sintetis (${chat ? '/api/rag/chat: retrieval + jawaban' : '/api/rag/search: retrieval saja'})\n`,
  );
  console.log(
    `  answerable       : ${recallHits}/${answerable.length} recall@5 = ${recall.toFixed(1)}%`,
    `  sitasi ber-anchor: ${anchored}/${citedTotal}`,
  );
  console.log(
    `  tanpa bukti      : ${abstained}/${noEvidence.length} abstain penuh (sisanya mengembalikan sumber lemah, tanpa jawaban)`,
  );
  console.log(
    `  lintas izin      : ${by('cross-permission').length - by('cross-permission').filter((o) => o.leaked.length > 0).length}/${by('cross-permission').length} tidak membocorkan apa pun`,
  );
  console.log(
    `  kebocoran total  : ${leaks.length}  ${leaks.length === 0 ? '(nol)' : '<-- GAGAL'}`,
  );
  console.log(
    `  latensi ${chat ? 'jawaban  ' : 'retrieval'}: p50 ${p(0.5)} ms · p95 ${p(0.95)} ms · maks ${latencies.at(-1)} ms`,
  );
  const fallbacks = outcomes.filter((o) => o.fellBack);
  if (chat)
    console.log(
      `  fallback WeKnora : ${fallbacks.length}/${outcomes.length} punya sumber tetapi tanpa jawaban tersusun (threshold/rerank WeKnora menolak semua kandidat)`,
    );

  const misses = answerable.filter((o) => !o.hit);
  if (misses.length) {
    console.log('\n  Tidak tercapai pada recall@5:');
    for (const m of misses)
      console.log(`    ${m.q.id}  ${m.q.question.slice(0, 62)}  (dikutip: ${m.citedDocs.length})`);
  }
  const weak = noEvidence.filter((o) => !o.abstained);
  if (weak.length) {
    console.log('\n  Tanpa bukti tetapi mengembalikan sumber:');
    for (const w of weak)
      console.log(
        `    ${w.q.id}  ${w.q.question.slice(0, 62)}  (dikutip: ${w.citedDocs.map((d) => d.slice(-4)).join(', ')})`,
      );
  }
  if (fallbacks.length) {
    console.log('\n  Sumber ada, jawaban fallback:');
    for (const f of fallbacks)
      console.log(`    ${f.q.id}  ${f.q.question.slice(0, 62)}  (dikutip: ${f.citedDocs.length})`);
  }
  if (leaks.length) {
    console.log('\n  KEBOCORAN:');
    for (const l of leaks)
      console.log(`    ${l.q.id}  ${l.q.question.slice(0, 62)}  -> ${l.leaked.join(', ')}`);
  }
  console.log(
    '\n  Recall dilaporkan, bukan digunakan sebagai gerbang lulus: angkanya berlaku untuk',
  );
  console.log('  corpus fixture ini saja. Kebocoran nol adalah syarat mutlak.\n');

  // Security expectations are the only hard failures.
  if (leaks.length > 0) process.exitCode = 1;
}

main().catch(reportFailure);
