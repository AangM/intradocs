import { requireApiActor } from '@/lib/session';
import { apiError, PRIVATE_HEADERS } from '@/lib/http';
import { exportAudit } from '@intradocs/db/queries';
import { InputError } from '@intradocs/core/validation';
import {
  AUDIT_EXPORT_LIMIT,
  auditCsv,
  auditJsonl,
  parseAuditFilter,
} from '@intradocs/core/audit-export';

export const dynamic = 'force-dynamic';

/**
 * The audit trail of a date range as a file (CSV or JSON Lines). Same capability and
 * RLS as the page; at most a year and 50 000 rows, and the file says when it was cut.
 * Taking the export is recorded in the trail itself.
 */
export async function GET(request: Request) {
  try {
    const actor = await requireApiActor('audit.view');
    const url = new URL(request.url);
    let filter;
    try {
      filter = parseAuditFilter({
        from: url.searchParams.get('from'),
        to: url.searchParams.get('to'),
        action: url.searchParams.get('action'),
      });
    } catch (e) {
      throw new InputError(e instanceof Error ? e.message : 'Filter tidak valid.');
    }
    const format = url.searchParams.get('format') ?? 'csv';
    if (format !== 'csv' && format !== 'jsonl') throw new InputError('Format: csv atau jsonl.');
    const { rows, truncated } = await exportAudit(actor, filter, AUDIT_EXPORT_LIMIT);
    const generatedAt = new Date().toISOString();
    const input = {
      generatedAt,
      generatedBy: actor.name,
      from: filter.from.toISOString(),
      to: filter.to.toISOString(),
      action: filter.action,
      rows,
      truncated,
    };
    const body = format === 'csv' ? auditCsv(input) : auditJsonl(input);
    const stamp = `${filter.from.toISOString().slice(0, 10)}_${filter.to.toISOString().slice(0, 10)}`;
    return new Response(body, {
      headers: {
        ...PRIVATE_HEADERS,
        'Content-Type':
          format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8',
        'Content-Disposition': `attachment; filename="intradocs-audit-${stamp}${filter.action ? '-' + filter.action.replace(/[^\w.]+/g, '_') : ''}.${format}"`,
      },
    });
  } catch (error) {
    return apiError(error);
  }
}
