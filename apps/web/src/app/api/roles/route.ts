import { NextResponse } from 'next/server';
import { mutation } from '@/lib/mutation';
import { requireApiActor } from '@/lib/session';
import { apiError, PRIVATE_HEADERS } from '@/lib/http';
import { parseCustomRole } from '@intradocs/core/roles';
import { listCustomRoles, saveCustomRole } from '@intradocs/db/roles';

/** Custom roles: anyone who can see users may list them; only a super admin defines one. */
export async function GET() {
  try {
    const actor = await requireApiActor('users.view');
    return NextResponse.json(
      { roles: await listCustomRoles(actor.id) },
      { headers: PRIVATE_HEADERS },
    );
  } catch (e) {
    return apiError(e);
  }
}

export async function POST(request: Request) {
  return mutation(request, 'users.manage', async (actor, body) => {
    const v = parseCustomRole(body);
    return { id: await saveCustomRole(actor.id, { ...v, id: null, revision: 0 }) };
  });
}
