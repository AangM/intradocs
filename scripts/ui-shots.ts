// Visual evidence for docs/UI.md §5: every mockup screen (the `.app` area of `#s1`–`#s10`,
// deck chrome excluded) and every portal page as one synthetic actor, at the same
// viewport, into var/shots/. Compare side by side; nothing here judges pixels for you.
//
//   pnpm ui:shots                 # mockup + app, 1440 px
//   SHOT_ONLY=s02,s03 pnpm ui:shots app
//   SHOT_W=390 pnpm ui:shots app  # mobile pass, files prefixed m-
//   SHOT_ACTOR=<uuid> ...         # another demo account (default: admin knowledge)
//
// Needs the app running (pnpm dev or pnpm start) and `pnpm exec playwright install chromium`.
import { chromium } from '@playwright/test';
import { readFile, mkdir } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { Pool } from 'pg';
import { ROOT, loadLocalEnv, localAdminUrl, reportFailure } from './shared.ts';
import { IDS } from '../fixtures/data.ts';

async function main(): Promise<void> {
  loadLocalEnv();
  const base = process.env.APP_URL!;
  const out = path.join(ROOT, 'var', 'shots');
  await mkdir(out, { recursive: true });
  const which = process.argv[2] ?? 'all';
  const viewport = {
    width: Number(process.env.SHOT_W ?? 1440),
    height: Number(process.env.SHOT_H ?? 2200),
  };
  const prefix = process.env.SHOT_W ? 'm-' : '';
  const browser = await chromium.launch();

  if (which === 'all' || which === 'mockup') {
    // The mockup is served, not opened as a file: file:// pages render as static
    // snapshots in some harnesses and the deck's own script must run to switch screens.
    const mockup = path.join(ROOT, 'reference', 'intradocs-mockup_1.html');
    const server = createServer((req, res) => {
      if (req.url?.startsWith('/mockup')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        createReadStream(mockup).pipe(res);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
    await page.goto(`http://127.0.0.1:${port}/mockup`, { waitUntil: 'load' });
    for (let n = 1; n <= 10; n++) {
      await page.evaluate((n) => {
        document.querySelectorAll('.screen').forEach((s) => s.classList.remove('on'));
        document.getElementById(`s${n}`)!.classList.add('on');
        const app = document.querySelector<HTMLElement>(`#s${n} .app`);
        if (app) app.style.height = 'auto';
        window.scrollTo(0, 0);
      }, n);
      await page
        .locator(`#s${n} .app`)
        .screenshot({ path: path.join(out, `mock-s${String(n).padStart(2, '0')}.png`) });
      console.log(`mock s${n}`);
    }
    await page.close();
    server.close();
  }

  if (which === 'all' || which === 'app') {
    const admin = new Pool({ connectionString: localAdminUrl(), max: 1 });
    const accounts = JSON.parse(
      await readFile(path.join(ROOT, 'var/demo-accounts.json'), 'utf8'),
    ) as Array<{ id: string; email: string; password: string }>;
    await admin.query('DELETE FROM auth."rateLimit"');
    const actorId = process.env.SHOT_ACTOR ?? IDS.admin;
    const a = accounts.find((x) => x.id === actorId);
    if (!a) throw new Error('Akun demo tidak ditemukan di var/demo-accounts.json.');
    const r = await fetch(base + '/api/auth/sign-in/email', {
      method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: a.email, password: a.password }),
    });
    if (!r.ok) throw new Error(`Login gagal: ${r.status}`);
    const cookies = r.headers.getSetCookie().map((c) => {
      const [pair] = c.split(';');
      const [name, ...v] = pair!.split('=');
      return { name: name!, value: v.join('='), url: base };
    });
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
    await context.addCookies(cookies);
    const page = await context.newPage();
    const doc =
      (
        await admin.query<{ id: string; slug: string }>(
          "SELECT id, slug FROM app.documents WHERE current_version_id IS NOT NULL AND slug='konfigurasi-vpn' LIMIT 1",
        )
      ).rows[0] ??
      (
        await admin.query<{ id: string; slug: string }>(
          'SELECT id, slug FROM app.documents WHERE current_version_id IS NOT NULL LIMIT 1',
        )
      ).rows[0];
    const routes: Array<[string, string]> = [
      ['login', '/login'],
      ['s01-help-center', '/help-center'],
      ['s02-search', '/search?q=VPN'],
      ['s03-katalog', '/katalog'],
      ['s04-reader', doc ? `/dokumen/${doc.id}/${doc.slug}` : '/katalog'],
      ['s05-unggah', '/unggah'],
      ['s06-approval', '/admin/approval'],
      ['s07-kategori-label', '/admin/kategori-label'],
      ['s08-pengguna', '/admin/pengguna'],
      ['s09-ai-assistant', '/ai-assistant'],
      ['s10-dashboard', '/admin/dashboard'],
      ['x-akses', '/akses'],
      ['x-notifikasi', '/notifikasi'],
      ['x-audit', '/admin/audit'],
      ['x-pengaturan', '/pengaturan'],
      ['x-feedback', '/feedback'],
    ];
    const only = process.env.SHOT_ONLY?.split(',').filter(Boolean);
    for (const [name, route] of routes) {
      if (only && !only.some((o) => name.includes(o))) continue;
      const file = path.join(out, `app-${prefix}${name}.png`);
      if (name === 'login') {
        const anon = await browser.newPage({ viewport, deviceScaleFactor: 1 });
        await anon.goto(base + route, { waitUntil: 'networkidle' });
        await anon.screenshot({ path: file, fullPage: true });
        await anon.close();
        console.log(name);
        continue;
      }
      await page.goto(base + route, { waitUntil: 'networkidle' });
      await page.waitForTimeout(400);
      if (name === 's05-unggah' && process.env.SHOT_STEP2) {
        const fixture = path.join(ROOT, 'fixtures/uploads/panduan-demo.md');
        if (existsSync(fixture)) {
          await page.setInputFiles('#source-file', fixture);
          await page.getByRole('button', { name: /Lanjut ke metadata/ }).click();
          await page.waitForTimeout(800);
        }
      }
      if (name === 's09-ai-assistant') {
        // Open the newest conversation so the thread, not the empty state, is captured.
        const conv = page.locator('.conv-open').first();
        if (await conv.count()) {
          await conv.click();
          await page
            .locator('.turn')
            .first()
            .waitFor({ timeout: 15000 })
            .catch(() => undefined);
          await page.waitForTimeout(300);
        }
      }
      await page.screenshot({ path: file, fullPage: true });
      console.log(name);
    }
    await context.close();
    await admin.end();
  }
  await browser.close();
  console.log(`Selesai: ${out}`);
}

main().catch(reportFailure);
