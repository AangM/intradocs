import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUDIT_ACTIONS,
  auditCsv,
  auditJsonl,
  parseAuditFilter,
  type AuditExportInput,
} from '../../packages/core/src/audit-export.ts';

const rows: AuditExportInput['rows'] = [
  {
    id: 'r1',
    createdAt: '2026-09-01T02:00:00.000Z',
    action: 'document.read',
    actorId: 'u1',
    actorName: 'Siti Rahmawati',
    documentId: 'd1',
    documentTitle: '=SUM(A1) "Konfigurasi" VPN, lengkap',
    subjectUserId: null,
    subjectName: null,
  },
  {
    id: 'r2',
    createdAt: '2026-09-02T02:00:00.000Z',
    action: 'user.deactivated',
    actorId: 'u2',
    actorName: null,
    documentId: null,
    documentTitle: null,
    subjectUserId: 'u9',
    subjectName: null,
  },
];
const input: AuditExportInput = {
  generatedAt: '2026-09-21T00:00:00.000Z',
  generatedBy: 'Budi Hartono',
  from: '2026-09-01T00:00:00.000Z',
  to: '2026-09-21T23:59:59.999Z',
  action: null,
  rows,
  truncated: false,
};

test('the filter defaults to 30 days, caps at a year, and knows only real actions', () => {
  const f = parseAuditFilter({});
  assert(f.to.getTime() - f.from.getTime() - 30 * 86_400_000 < 1000);
  assert.equal(f.action, null);
  const g = parseAuditFilter({ from: '2026-01-01', to: '2026-01-31', action: 'document.read' });
  assert.equal(g.from.toISOString(), '2026-01-01T00:00:00.000Z');
  assert.equal(g.to.toISOString(), '2026-01-31T23:59:59.999Z');
  assert.equal(g.action, 'document.read');
  assert.throws(() => parseAuditFilter({ from: '2026-02-01', to: '2026-01-01' }), /awal setelah/);
  assert.throws(() => parseAuditFilter({ from: '2025-01-01', to: '2026-06-01' }), /satu tahun/);
  assert.throws(() => parseAuditFilter({ action: 'document.evil' }), /tidak dikenal/);
  assert.throws(() => parseAuditFilter({ from: '2026-13-40' }), /tidak valid/);
});

test('CSV: header, one line per event, shielded names, neutralised formulas, a trailer', () => {
  const csv = auditCsv(input);
  const lines = csv.split('\r\n');
  assert(
    lines[0]!.startsWith(
      '# IntraDocs audit log,dibuat 2026-09-21T00:00:00.000Z,oleh Budi Hartono,rentang 2026-09-01..2026-09-21',
    ),
  );
  assert.equal(
    lines[1],
    'id,waktu_utc,aktivitas,keterangan,pelaku_id,pelaku,dokumen_id,dokumen,subjek_id,subjek',
  );
  assert.equal(
    lines[2],
    'r1,2026-09-01T02:00:00.000Z,document.read,Dokumen dibuka,u1,Siti Rahmawati,d1,"\'=SUM(A1) ""Konfigurasi"" VPN, lengkap",,',
  );
  assert.equal(
    lines[3],
    'r2,2026-09-02T02:00:00.000Z,user.deactivated,Akun dinonaktifkan,u2,(di luar cakupan),,,u9,(di luar cakupan)',
  );
  assert.equal(lines[4], '# 2 baris');
  assert.equal(lines[5], '');
  assert.match(auditCsv({ ...input, truncated: true }), /terpotong pada 50000/);
});

test('JSON Lines: a header, one object per event, a trailer with the count', () => {
  const out = auditJsonl(input)
    .trimEnd()
    .split('\n')
    .map((l) => JSON.parse(l));
  assert.equal(out.length, 4);
  assert.deepEqual(out[0], {
    type: 'header',
    generatedAt: input.generatedAt,
    generatedBy: 'Budi Hartono',
    from: input.from,
    to: input.to,
    action: null,
  });
  assert.deepEqual(out[1], {
    type: 'event',
    id: 'r1',
    at: '2026-09-01T02:00:00.000Z',
    action: 'document.read',
    label: 'Dokumen dibuka',
    actor: { id: 'u1', name: 'Siti Rahmawati' },
    document: { id: 'd1', title: '=SUM(A1) "Konfigurasi" VPN, lengkap' },
    subject: null,
  });
  assert.deepEqual(out[2].subject, { id: 'u9', name: null });
  assert.deepEqual(out[3], { type: 'trailer', rows: 2, truncated: false });
});

test('every action the database accepts has words', async () => {
  const { readFile, readdir } = await import('node:fs/promises');
  const dir = 'packages/db/migrations';
  let latest = '';
  for (const f of (await readdir(dir)).sort()) {
    const sql = await readFile(`${dir}/${f}`, 'utf8');
    const m = [...sql.matchAll(/audit_events_action_check CHECK\(action IN \(([\s\S]*?)\)\)/g)].at(
      -1,
    );
    if (m) latest = m[1]!;
  }
  const actions = [...latest.matchAll(/'([a-z_.]+)'/g)].map((m) => m[1]!);
  assert(actions.length > 30);
  for (const a of actions) assert(a in AUDIT_ACTIONS, `no label for ${a}`);
});
