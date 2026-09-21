// Q5 accessibility gate (docs/PLAN.md): axe on every screen S01-S10 plus login, with no
// serious or critical violation, and keyboard-only paths through the controls a person
// actually needs. Moderate and minor findings are printed, not failed, so the report is
// read rather than silenced. Runs against the local app with synthetic accounts.
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';
import { ROOT, localAdminUrl } from '../../scripts/shared.ts';
import type { DemoAccount } from '../../scripts/seed.ts';
import { IDS } from '../../fixtures/data.ts';

let accounts: DemoAccount[];
let db: Pool;
let doc: { id: string; slug: string } | undefined;

test.beforeAll(async () => {
  db = new Pool({ connectionString: localAdminUrl(), max: 1 });
  accounts = JSON.parse(
    await readFile(path.join(ROOT, 'var/demo-accounts.json'), 'utf8'),
  ) as DemoAccount[];
  doc = (
    await db.query<{ id: string; slug: string }>(
      "SELECT id, slug FROM app.documents WHERE current_version_id IS NOT NULL AND slug='konfigurasi-vpn' LIMIT 1",
    )
  ).rows[0];
});
test.afterAll(async () => {
  await db.end();
});

async function login(page: Page, actorId: string) {
  await db.query('DELETE FROM auth."rateLimit"');
  const account = accounts.find((a) => a.id === actorId)!;
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(account.email);
  await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Masuk ke IntraDocs' }).click();
  await expect(page).toHaveURL(/help-center/);
}

/** Serious and critical are the gate; the rest is reported for the record. */
async function audit(page: Page, label: string) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'best-practice'])
    // The mockup's own decorative colour dots and the code block theme are outside the
    // contract; everything else on the page is audited.
    .exclude('.category-dot')
    .analyze();
  const blocking = results.violations.filter((v) =>
    ['serious', 'critical'].includes(v.impact ?? ''),
  );
  const rest = results.violations.filter((v) => !['serious', 'critical'].includes(v.impact ?? ''));
  if (rest.length)
    console.log(
      `[a11y] ${label}: ${rest
        .map(
          (v) =>
            `${v.id} (${v.impact}, ${v.nodes.length}${
              process.env.A11Y_VERBOSE
                ? `: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`
                : ''
            })`,
        )
        .join(', ')}`,
    );
  expect(
    blocking.map((v) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ')),
    })),
    `${label}: serious/critical violations`,
  ).toEqual([]);
}

test('login has no serious or critical axe violations', async ({ page }) => {
  await page.goto('/login');
  await audit(page, 'login');
});

test('every portal screen S01-S10 has no serious or critical axe violations', async ({ page }) => {
  test.setTimeout(240_000);
  await login(page, IDS.admin);
  const screens: Array<[string, string]> = [
    ['S01 help-center', '/help-center'],
    ['S02 search', '/search?q=VPN'],
    ['S03 katalog', '/katalog'],
    ['S04 reader', doc ? `/dokumen/${doc.id}/${doc.slug}` : '/katalog'],
    ['S05 unggah', '/unggah'],
    ['S06 approval', '/admin/approval'],
    ['S07 kategori-label', '/admin/kategori-label'],
    ['S08 pengguna', '/admin/pengguna'],
    ['S09 ai-assistant', '/ai-assistant'],
    ['S10 dashboard', '/admin/dashboard'],
    ['notifikasi', '/notifikasi'],
    ['akses', '/akses'],
    ['pengaturan', '/pengaturan'],
  ];
  for (const [label, url] of screens) {
    await page.goto(url);
    await page.waitForLoadState('networkidle');
    await audit(page, label);
  }
});

test('keyboard only: skip link, login form, search, and the sidebar drawer', async ({
  page,
}, info) => {
  // Login: Tab reaches email, password, submit in order; Enter submits.
  await db.query('DELETE FROM auth."rateLimit"');
  const account = accounts.find((a) => a.id === IDS.viewer)!;
  await page.goto('/login');
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Email', { exact: true })).toBeFocused();
  await page.keyboard.type(account.email);
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Password', { exact: true })).toBeFocused();
  await page.keyboard.type(account.password);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/help-center/);

  // The first Tab on a portal page is the skip link; Enter lands on the main region.
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Lewati navigasi' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main-content')).toBeFocused();

  // Keyword search entirely from the keyboard.
  await page.goto('/search');
  const box = page.getByRole('textbox', { name: 'Kata kunci' });
  for (let i = 0; i < 25 && !(await box.evaluate((el) => el === document.activeElement)); i++)
    await page.keyboard.press('Tab');
  await expect(box).toBeFocused();
  await page.keyboard.type('VPN');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/q=VPN/);
  await expect(page.getByRole('link', { name: /Konfigurasi VPN/ }).first()).toBeVisible();

  if (info.project.name === 'mobile') {
    // The drawer opens from its button, closes on Escape, and focus stays sane.
    const menu = page.getByRole('button', { name: /menu/i }).first();
    await menu.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#side-menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.nav-open')).toHaveCount(0);
  }
});

test('keyboard only: the role dialog opens, traps nothing, and closes on Escape', async ({
  page,
}) => {
  await login(page, IDS.super);
  await page.goto('/admin/pengguna');
  const edit = page.getByRole('button', { name: 'Edit penugasan' }).first();
  await edit.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  // Tab moves inside the open dialog, not behind it.
  await page.keyboard.press('Tab');
  const inside = await page.evaluate(() => !!document.activeElement?.closest('dialog[open]'));
  expect(inside).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});
