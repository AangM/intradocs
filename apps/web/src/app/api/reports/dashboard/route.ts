import { requireApiActor } from '@/lib/session';
import { apiError, PRIVATE_HEADERS } from '@/lib/http';
import { dashboardData } from '@intradocs/db/discovery';
import { dashboardCsv } from '@intradocs/core/dashboard-export';

export const dynamic = 'force-dynamic';

/**
 * The dashboard's numbers as a CSV file, for the period and unit the page shows
 * (PRD S10 V1 "laporan ekspor"). Same capability, same RLS-filtered query as the page;
 * knowledge-gap terms are left out on purpose (see dashboard-export.ts).
 */
export async function GET(request: Request) {
  try {
    const actor = await requireApiActor('analytics.view');
    const url = new URL(request.url);
    const raw = url.searchParams.get('days') ?? '30';
    const days = ['7', '30', '90'].includes(raw) ? Number(raw) : 30;
    const unit = (url.searchParams.get('unit') ?? '').trim().slice(0, 80) || null;
    const data = await dashboardData(actor.id, days, unit);
    const generatedAt = new Date().toISOString();
    const csv = dashboardCsv({
      generatedAt,
      days,
      unit,
      summary: data.summary,
      activity: data.activity,
      search: {
        total: Number(data.search.total),
        zero: Number(data.search.zero),
        avgMs: Number(data.search.avg_ms ?? 0),
      },
      approvalHours: data.approvalHours,
      ai: data.ai,
      contributors: data.contributors,
      latest: data.latest.map((d) => ({ title: d.title, format: d.format })),
    });
    return new Response(csv, {
      headers: {
        ...PRIVATE_HEADERS,
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="intradocs-dashboard-${generatedAt.slice(0, 10)}-${days}h${unit ? '-' + unit.replace(/[^\w-]+/g, '_') : ''}.csv"`,
      },
    });
  } catch (error) {
    return apiError(error);
  }
}
