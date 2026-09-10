import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';
import { ROOT, localAdminUrl } from '../../scripts/shared.ts';
import type { DemoAccount } from '../../scripts/seed.ts';
import { IDS, docId } from '../../fixtures/data.ts';
let account: DemoAccount;
let db: Pool;
test.beforeAll(async () => {
  db = new Pool({ connectionString: localAdminUrl(), max: 1 });
  const accounts = JSON.parse(
    await readFile(path.join(ROOT, 'var/demo-accounts.json'), 'utf8'),
  ) as DemoAccount[];
  account = accounts.find((a) => a.id === IDS.viewer)!;
});
test.afterAll(async () => {
  await db.end();
});
test.beforeEach(async ({ page }) => {
  await db.query('DELETE FROM auth."rateLimit"');
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(account.email);
  await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Masuk ke IntraDocs' }).click();
  await expect(page).toHaveURL(/help-center/);
});
test('home, metadata search, protected reader and accessible headings', async ({ page }, info) => {
  await expect(page.getByRole('heading', { name: 'Ada yang bisa kami bantu?' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Apa yang ingin Anda cari?' }).fill('VPN');
  await page.getByRole('button', { name: 'Cari dokumen', exact: true }).click();
  await page.getByRole('link', { name: 'Konfigurasi VPN untuk Windows, macOS & Mobile' }).click();
  await expect(
    page
      .getByRole('heading', { name: 'Konfigurasi VPN untuk Windows, macOS & Mobile', level: 1 })
      .first(),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Unduh Markdown' })).toBeVisible();
  expect(await page.locator('script[src^="http"]').count()).toBe(0);
  await page.screenshot({ path: info.outputPath('reader.png'), fullPage: true });
});
test('no horizontal page overflow and an AI composer that matches the configuration', async ({
  page,
}, info) => {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: info.outputPath('home.png'), fullPage: true });
  await page.goto('/ai-assistant');
  // The composer must tell the truth either way: usable only when retrieval is actually
  // configured, and visibly inert when AI is off. A disabled box on a working install
  // would be as wrong as an enabled box on an install with no engine behind it.
  const composer = page.getByLabel('Pertanyaan AI');
  if (process.env.AI_PROVIDER === 'weknora-local') {
    await expect(composer).toBeEnabled();
    // Send stays disabled until there is something to ask, so type before asserting.
    await expect(page.getByRole('button', { name: 'Kirim' })).toBeDisabled();
    // The composer is controlled by React state; filling it before hydration sets the DOM
    // value but not the state, and the next render clears it again. Wait for the handler
    // to exist rather than typing into a component that is not listening yet.
    await page.waitForFunction(() => {
      const el = document.querySelector('textarea');
      return !!el && Object.keys(el).some((k) => k.startsWith('__react'));
    });
    await composer.fill('Bagaimana konfigurasi VPN?');
    await expect(composer).toHaveValue('Bagaimana konfigurasi VPN?');
    await expect(page.getByRole('button', { name: 'Kirim' })).toBeEnabled();
  } else {
    await expect(composer).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Kirim' })).toBeDisabled();
  }
});
test('direct navigation to an unauthorized document never shows its title or body', async ({
  page,
}) => {
  await page.goto(`/dokumen/${docId(7)}/lampiran-keamanan`);
  await expect(page.getByText('SYNTHETIC-CONFIDENTIAL-CANARY-7')).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'Lampiran Simulasi Keamanan — Rahasia' }),
  ).toHaveCount(0);
});
