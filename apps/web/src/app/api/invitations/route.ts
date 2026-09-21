import { NextResponse } from 'next/server';
import { mutation } from '@/lib/mutation';
import { requireApiActor } from '@/lib/session';
import { apiError, PRIVATE_HEADERS } from '@/lib/http';
import { readRuntimeConfig } from '@intradocs/core/config';
import { InputError, parseUuid } from '@intradocs/core/validation';
import { createInvitation, listInvitations } from '@intradocs/db/invitations';

const ROLES = ['knowledge_admin', 'reviewer', 'contributor', 'viewer'];

export async function GET() {
  try {
    const actor = await requireApiActor('users.view');
    return NextResponse.json(
      { invitations: await listInvitations(actor.id) },
      { headers: PRIVATE_HEADERS },
    );
  } catch (e) {
    return apiError(e);
  }
}

/**
 * Issues an invitation. Authority (who may invite whom, into which unit and scope) is
 * decided by app.create_invitation; the token comes back exactly once, as a link the
 * administrator passes on themselves -- there is no mail here.
 */
export async function POST(request: Request) {
  return mutation(request, 'users.view', async (actor, body) => {
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new InputError('Payload tidak valid.');
    const v = body as Record<string, unknown>;
    const keys = Object.keys(v)
      .filter((k) => k !== 'customRoleId')
      .sort()
      .join(',');
    if (keys !== 'categoryIds,email,name,role,scopeAll,unit')
      throw new InputError('Field undangan tidak lengkap.');
    const text = (value: unknown, min: number, max: number, label: string) => {
      if (typeof value !== 'string' || value.trim().length < min || value.length > max)
        throw new InputError(`${label} harus ${min}–${max} karakter.`);
      return value.trim();
    };
    const email = text(v.email, 5, 254, 'Email').toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new InputError('Email tidak valid.');
    if (!ROLES.includes(String(v.role))) throw new InputError('Role tidak valid.');
    if (
      typeof v.scopeAll !== 'boolean' ||
      !Array.isArray(v.categoryIds) ||
      v.categoryIds.length > 100
    )
      throw new InputError('Cakupan tidak valid.');
    const created = await createInvitation(actor.id, {
      email,
      name: text(v.name, 2, 120, 'Nama'),
      unit: text(v.unit, 2, 80, 'Unit'),
      role: String(v.role),
      scopeAll: v.scopeAll,
      categoryIds: [...new Set(v.categoryIds.map(parseUuid))],
      customRoleId:
        v.customRoleId === undefined || v.customRoleId === null ? null : parseUuid(v.customRoleId),
    });
    const origin = readRuntimeConfig(process.env).appUrl.replace(/\/$/, '');
    return { id: created.id, link: `${origin}/undangan/${created.token}` };
  });
}
