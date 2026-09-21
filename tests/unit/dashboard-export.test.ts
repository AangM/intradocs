// The dashboard CSV: the page's numbers and nothing that is not on the page; cells
// that a spreadsheet would execute are neutralised; UTF-8 with a BOM for Excel.
import test from 'node:test';
import assert from 'node:assert/strict';
import { csvField, dashboardCsv } from '../../packages/core/src/dashboard-export.ts';

test('cells are quoted when needed and formula prefixes are neutralised', () => {
  assert.equal(csvField('plain'), 'plain');
  assert.equal(csvField('a, b'), '"a, b"');
  assert.equal(csvField('say "hi"'), '"say ""hi"""');
  assert.equal(csvField('=SUM(A1)'), "'=SUM(A1)");
  assert.equal(csvField('+1'), "'+1");
  assert.equal(csvField('-5'), "'-5");
  assert.equal(csvField('@cmd'), "'@cmd");
  assert.equal(csvField(7), '7');
  assert.equal(csvField(null), '');
});

test('the report carries the sections the page shows, in the period and unit asked', () => {
  const csv = dashboardCsv({
    generatedAt: '2026-09-13T10:00:00.000Z',
    days: 30,
    unit: 'IT Governance',
    summary: { active: 9, reviewing: 1, drafts: 0, expired: 0 },
    activity: [
      { day: '2026-09-12', reads: 3, asks: 1 },
      { day: '2026-09-13', reads: 5, asks: 2 },
    ],
    search: { total: 8, zero: 1, avgMs: 210 },
    approvalHours: 1.234,
    ai: {
      retrievals: 4,
      answers: 2,
      abstained: 1,
      rejected: 3,
      helpful: 1,
      unhelpful: 0,
      people: 2,
    },
    contributors: [{ name: 'Rizky Ananda', total: 2 }],
    latest: [{ title: 'Panduan, dengan koma', format: 'MD' }],
  });
  assert(csv.startsWith('\uFEFF'));
  const lines = csv.split('\r\n');
  assert.equal(lines[0], '\uFEFFLaporan dashboard IntraDocs');
  assert(lines.includes('Unit,IT Governance'));
  assert(lines.includes('Dokumen aktif,9'));
  assert(lines.includes('Rata-rata waktu approval (jam),1.23'));
  assert(lines.includes('2026-09-13,5,2'));
  assert(lines.includes('Rizky Ananda,2'));
  assert(lines.includes('"Panduan, dengan koma",MD'));
  // No knowledge-gap terms and no per-person identifiers beyond the contributor tally.
  assert(!/gap|kesenjangan|@/i.test(csv));
});
