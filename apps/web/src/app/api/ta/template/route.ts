import { TA_CSV_ELEMENT_HEADER, TA_CSV_RELATION_HEADER } from '@intradocs/core/ta';
import { requireApiActor } from '@/lib/session';
import { apiError, PRIVATE_HEADERS } from '@/lib/http';

/** The CSV template: the element sheet, then "#relations" and the relation sheet, with one example row each. */
export async function GET() {
  try {
    await requireApiActor('taxonomy.view');
    const body = [
      TA_CSV_ELEMENT_HEADER.join(','),
      '{11111111-2222-3333-4444-555555555555},Node,virtual machine,srv-contoh-01,Approved,Contoh VM (hapus baris ini),srv-contoh-01,10.0.0.10,production,DC Contoh,Ubuntu Server,22.04 LTS,Tim Infrastruktur,2027-04-30',
      '{66666666-7777-8888-9999-000000000000},Component,ArchiMate_ApplicationComponent,Aplikasi Contoh,Approved,,,,production,,,,Tim Aplikasi,',
      '#relations',
      TA_CSV_RELATION_HEADER.join(','),
      ',{66666666-7777-8888-9999-000000000000},{11111111-2222-3333-4444-555555555555},Deployment,',
    ].join('\r\n');
    return new Response(body + '\r\n', {
      headers: {
        ...PRIVATE_HEADERS,
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="template-technology-architecture.csv"',
      },
    });
  } catch (e) {
    return apiError(e);
  }
}
