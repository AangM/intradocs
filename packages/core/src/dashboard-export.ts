/**
 * The dashboard as a CSV report (PRD S10 V1 "laporan ekspor"): the same numbers the
 * page shows, for the same period and unit, under the same RLS -- and nothing else.
 * Deliberately excluded: the knowledge-gap terms (a normalised search log; the
 * dashboard shows them only above the k-anonymity threshold and a spreadsheet should not
 * become the place they travel) and any per-person data beyond the contributor tally
 * already on screen. Sections are stacked in one file with a blank line between them,
 * which spreadsheet software opens as-is.
 */
export interface DashboardReportInput {
  generatedAt: string;
  days: number;
  unit: string | null;
  summary: { active: number; reviewing: number; drafts: number; expired: number };
  activity: ReadonlyArray<{ day: string; reads: number; asks: number }>;
  search: { total: number; zero: number; avgMs: number };
  approvalHours: number | null;
  ai: {
    retrievals: number;
    answers: number;
    abstained: number;
    rejected: number;
    helpful: number;
    unhelpful: number;
    people: number;
  };
  contributors: ReadonlyArray<{ name: string; total: number }>;
  latest: ReadonlyArray<{ title: string; format: string }>;
}

/** One CSV field: quoted when it needs to be; a leading formula character is neutralised. */
export function csvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  // A cell starting with = + - @ would be executed as a formula by spreadsheet software.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function dashboardCsv(input: DashboardReportInput): string {
  const row = (...cells: Array<string | number | null | undefined>) =>
    cells.map(csvField).join(',');
  const lines: string[] = [];
  lines.push(row('Laporan dashboard IntraDocs'));
  lines.push(row('Dibuat', input.generatedAt));
  lines.push(row('Periode (hari)', input.days));
  lines.push(row('Unit', input.unit ?? 'semua unit terlihat'));
  lines.push('');
  lines.push(row('Ringkasan', 'Nilai'));
  lines.push(row('Dokumen aktif', input.summary.active));
  lines.push(row('Menunggu approval', input.summary.reviewing));
  lines.push(row('Draft / revisi', input.summary.drafts));
  lines.push(row('Kedaluwarsa', input.summary.expired));
  lines.push(row('Pencarian', input.search.total));
  lines.push(row('Pencarian tanpa hasil', input.search.zero));
  lines.push(row('Rata-rata durasi pencarian (ms)', input.search.avgMs));
  lines.push(
    row(
      'Rata-rata waktu approval (jam)',
      input.approvalHours === null ? '' : Math.round(input.approvalHours * 100) / 100,
    ),
  );
  lines.push(row('AI: pengambilan sumber', input.ai.retrievals));
  lines.push(row('AI: jawaban tersusun', input.ai.answers));
  lines.push(row('AI: tidak terjawab', input.ai.abstained));
  lines.push(row('AI: kutipan disaring', input.ai.rejected));
  lines.push(row('AI: dinilai membantu', input.ai.helpful));
  lines.push(row('AI: dinilai tidak membantu', input.ai.unhelpful));
  lines.push(row('AI: orang yang bertanya', input.ai.people));
  lines.push('');
  lines.push(row('Tanggal', 'Pembacaan', 'Pertanyaan AI'));
  for (const a of input.activity) lines.push(row(a.day, a.reads, a.asks));
  lines.push('');
  lines.push(row('Kontributor', 'Dokumen disetujui'));
  for (const c of input.contributors) lines.push(row(c.name, c.total));
  lines.push('');
  lines.push(row('Publikasi terbaru', 'Format'));
  for (const d of input.latest) lines.push(row(d.title, d.format));
  // BOM so Excel on Windows reads UTF-8 (Indonesian titles) without an import dialog.
  return `﻿${lines.join('\r\n')}\r\n`;
}
