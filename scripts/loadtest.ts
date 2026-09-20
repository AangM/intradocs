/**
 * Q5 load test. Answers one question honestly: how many concurrent readers does this
 * build serve, on this machine, before latency stops being acceptable?
 *
 *   pnpm ops:loadtest [--users 20] [--seconds 20] [--budget 800]
 *
 * It signs in as real demo accounts and requests the pages a reader actually opens --
 * home, catalogue, search, a document -- through the running server, with RLS, sessions
 * and the real database in the path. Nothing is mocked, so the numbers describe this
 * stack rather than a synthetic endpoint.
 *
 * The assistant is deliberately out of scope: one answer occupies a 3B model for seconds
 * and would measure Ollama, not the portal. Its capacity is a separate question with a
 * separate answer (one generation at a time on the reference machine).
 *
 * The exit code is the gate: 1 when p95 of any page exceeds --budget or any request
 * fails, so this can run in a release pipeline rather than only by hand.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';
import { ROOT, loadLocalEnv, localAdminUrl, reportFailure } from './shared.ts';

type Sample = { route: string; ms: number; ok: boolean; status: number };

function flag(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  const value = i > 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

async function main(): Promise<void> {
  loadLocalEnv();
  const base = process.env.APP_URL!;
  const users = Math.round(flag('users', 20));
  const seconds = Math.round(flag('seconds', 20));
  const budget = Math.round(flag('budget', 800));
  const admin = new Pool({ connectionString: localAdminUrl(), max: 1 });
  await admin.query('DELETE FROM auth."rateLimit"');
  const accounts = JSON.parse(
    await readFile(path.join(ROOT, 'var/demo-accounts.json'), 'utf8'),
  ) as Array<{ id: string; email: string; password: string; role: string }>;
  // Readers, not administrators: the mix an office of people actually produces.
  const readers = accounts.filter((a) => a.email !== 'nonaktif@example.test');
  const doc = (
    await admin.query<{ id: string; slug: string }>(
      'SELECT id,slug FROM app.documents WHERE current_version_id IS NOT NULL ORDER BY id LIMIT 1',
    )
  ).rows[0]!;
  const routes = [
    ['beranda', '/help-center'],
    ['katalog', '/katalog'],
    ['pencarian', '/search?q=VPN'],
    ['dokumen', `/dokumen/${doc.id}/${doc.slug}`],
  ] as const;

  const cookies: string[] = [];
  for (const a of readers) {
    // Five sign-ins a minute is the production rate limit and it applies here too;
    // clearing between logins keeps the limiter measuring what it is for (a person
    // guessing a password) rather than this harness setting itself up.
    await admin.query('DELETE FROM auth."rateLimit"');
    const r = await fetch(`${base}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: a.email, password: a.password }),
    });
    if (!r.ok) throw new Error(`Login ${a.email} gagal: HTTP ${r.status}`);
    cookies.push(
      r.headers
        .getSetCookie()
        .map((c) => c.split(';')[0])
        .join('; '),
    );
  }
  await admin.query('DELETE FROM auth."rateLimit"');

  console.log(`${users} pembaca serentak · ${seconds} detik · anggaran p95 ${budget} ms · ${base}`);
  const samples: Sample[] = [];
  const deadline = Date.now() + seconds * 1000;
  let warmupDone = false;
  // Each virtual reader loops through the pages at its own pace, like a person moving
  // around the portal rather than hammering one URL.
  const reader = async (n: number) => {
    const cookie = cookies[n % cookies.length]!;
    for (let i = 0; Date.now() < deadline; i++) {
      const [label, route] = routes[(n + i) % routes.length]!;
      const started = performance.now();
      let status = 0;
      try {
        const r = await fetch(base + route, {
          headers: { Cookie: cookie },
          signal: AbortSignal.timeout(30_000),
        });
        status = r.status;
        await r.arrayBuffer();
      } catch {
        status = 0;
      }
      const ms = performance.now() - started;
      // The first pass through each route compiles and fills caches; measuring it would
      // describe a cold start, not steady state.
      if (warmupDone) samples.push({ route: label, ms, ok: status === 200, status });
    }
  };
  // One unmeasured pass first.
  await Promise.all(
    routes.map(([, route], i) =>
      fetch(base + route, { headers: { Cookie: cookies[i % cookies.length]! } }).then((r) =>
        r.arrayBuffer(),
      ),
    ),
  );
  warmupDone = true;
  const started = Date.now();
  await Promise.all(Array.from({ length: users }, (_, n) => reader(n)));
  const elapsed = (Date.now() - started) / 1000;
  await admin.end();

  let failed = false;
  const width = Math.max(...routes.map(([l]) => l.length));
  console.log(
    `\n${'halaman'.padEnd(width)}  ${'n'.padStart(5)}  ${'p50'.padStart(7)}  ${'p95'.padStart(7)}  ${'maks'.padStart(7)}  gagal`,
  );
  for (const [label] of routes) {
    const mine = samples.filter((s) => s.route === label);
    const times = mine.map((s) => s.ms).sort((a, b) => a - b);
    const bad = mine.filter((s) => !s.ok).length;
    const p95 = percentile(times, 95);
    if (bad || p95 > budget) failed = true;
    console.log(
      `${label.padEnd(width)}  ${String(mine.length).padStart(5)}  ${percentile(times, 50).toFixed(0).padStart(6)}ms  ${p95.toFixed(0).padStart(6)}ms  ${(times.at(-1) ?? 0).toFixed(0).padStart(6)}ms  ${bad}`,
    );
  }
  const rps = samples.length / elapsed;
  console.log(
    `\n${samples.length} permintaan dalam ${elapsed.toFixed(1)} s · ${rps.toFixed(1)} req/s · ${samples.filter((s) => !s.ok).length} gagal`,
  );
  if (failed) {
    console.error(`Anggaran p95 ${budget} ms terlampaui atau ada permintaan gagal.`);
    process.exitCode = 1;
  }
}

main().catch(reportFailure);
