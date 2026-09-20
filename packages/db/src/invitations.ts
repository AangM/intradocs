import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';
import { InputError } from '@intradocs/core/validation';
import { getPool, withActor } from './index.ts';
import { translateWorkflowError } from './workflow.ts';

/**
 * Local invitations (migration 032). Authority and every state check live in SQL; this
 * module hashes tokens, drives the two-step acceptance, and never logs a token or a
 * password.
 */

const TOKEN_BYTES = 32;
const TTL = '72 hours';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface InvitationInput {
  email: string;
  name: string;
  unit: string;
  role: string;
  scopeAll: boolean;
  categoryIds: string[];
  /** A custom role whose base must equal `role`; SQL checks that. */
  customRoleId?: string | null;
}

/** Creates the row and returns the one-time token; the caller shows it once. */
export async function createInvitation(
  actorId: string,
  input: InvitationInput,
): Promise<{ id: string; token: string }> {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  try {
    const id = await withActor(actorId, async ({ client }) => {
      const { rows } = await client.query<{ id: string }>(
        'SELECT app.create_invitation($1,$2,$3,$4,$5,$6,$7::uuid[],$8::interval,$9::uuid) AS id',
        [
          hashToken(token),
          input.email.trim().toLowerCase(),
          input.name,
          input.unit,
          input.role,
          input.scopeAll,
          input.categoryIds,
          TTL,
          input.customRoleId ?? null,
        ],
      );
      return rows[0]!.id;
    });
    return { id, token };
  } catch (e) {
    if ((e as { code?: string }).code === '23505')
      throw new InputError('Alamat itu sudah punya akun atau undangan yang masih terbuka.');
    return translateWorkflowError(e);
  }
}

export interface InvitationRow {
  id: string;
  email: string;
  name: string;
  unit: string;
  role: string;
  /** The custom role's name when the invitation carries one. */
  roleLabel: string | null;
  scopeAll: boolean;
  categories: string[];
  createdAt: string;
  expiresAt: string;
  state: 'open' | 'accepted' | 'revoked' | 'expired';
}

export async function listInvitations(actorId: string): Promise<InvitationRow[]> {
  return withActor(actorId, async ({ client }) => {
    const { rows } = await client.query<{
      id: string;
      email: string;
      name: string;
      unit: string;
      role: string;
      role_label: string | null;
      scope_all: boolean;
      categories: string[] | null;
      created_at: string;
      expires_at: string;
      accepted_at: string | null;
      revoked_at: string | null;
      expired: boolean;
    }>(
      `SELECT i.id,i.email,i.name,i.unit,i.role,i.scope_all,
        (SELECT r.name FROM app.custom_roles r WHERE r.id=i.custom_role_id) AS role_label,
        (SELECT array_agg(c.name ORDER BY c.name) FROM app.categories c WHERE c.id=ANY(i.category_ids)) AS categories,
        i.created_at::text,i.expires_at::text,i.accepted_at::text,i.revoked_at::text,
        (i.expires_at<=now()) AS expired
       FROM app.invitations i ORDER BY i.created_at DESC LIMIT 200`,
    );
    return rows.map((r) => ({
      id: r.id,
      email: r.email,
      name: r.name,
      unit: r.unit,
      role: r.role,
      roleLabel: r.role_label,
      scopeAll: r.scope_all,
      categories: r.categories ?? [],
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      state: r.accepted_at ? 'accepted' : r.revoked_at ? 'revoked' : r.expired ? 'expired' : 'open',
    }));
  });
}

export async function revokeInvitation(actorId: string, id: string): Promise<void> {
  try {
    await withActor(actorId, async ({ client }) => {
      await client.query('SELECT app.revoke_invitation($1)', [id]);
    });
  } catch (e) {
    translateWorkflowError(e);
  }
}

export interface OpenInvitation {
  id: string;
  email: string;
  name: string;
  unit: string;
  role: string;
  /** Custom role name, when the invitation carries one. */
  roleLabel: string | null;
}

/** What the acceptance page may show; nothing for a token that is not open. */
export async function openInvitation(token: string): Promise<OpenInvitation | null> {
  if (!/^[A-Za-z0-9_-]{40,50}$/.test(token)) return null;
  const { rows } = await getPool('app').query<
    Omit<OpenInvitation, 'roleLabel'> & { role_label: string | null }
  >('SELECT id,email,name,unit,role,role_label FROM app.open_invitation($1)', [hashToken(token)]);
  const r = rows[0];
  return r
    ? {
        id: r.id,
        email: r.email,
        name: r.name,
        unit: r.unit,
        role: r.role,
        roleLabel: r.role_label,
      }
    : null;
}

/**
 * Accepts an invitation: creates the auth user and its credential account in the auth
 * schema (as the seed does), then completes the profile through app.accept_invitation.
 * Two databases, two steps; if the second fails the auth rows are removed again so a
 * half-made account never exists.
 */
export async function acceptInvitation(
  token: string,
  password: string,
): Promise<{ userId: string; email: string }> {
  const open = await openInvitation(token);
  if (!open) throw new InputError('Undangan tidak ditemukan, sudah dipakai, atau kedaluwarsa.');
  if (typeof password !== 'string' || password.length < 12 || password.length > 128)
    throw new InputError('Password minimal 12 karakter.');
  const userId = randomUUID();
  const auth = getPool('auth');
  const passwordHash = await hashPassword(password);
  await auth.query('BEGIN');
  try {
    await auth.query(
      'INSERT INTO auth."user"(id,name,email,"emailVerified") VALUES($1,$2,$3,true)',
      [userId, open.name, open.email],
    );
    await auth.query(
      `INSERT INTO auth.account(id,"accountId","providerId","userId",issuer,password)
       VALUES($1,$2,'credential',$2,'local:credential',$3)`,
      [randomUUID(), userId, passwordHash],
    );
    await auth.query('COMMIT');
  } catch (e) {
    await auth.query('ROLLBACK').catch(() => undefined);
    if ((e as { code?: string }).code === '23505')
      throw new InputError('Alamat itu sudah punya akun.');
    throw e;
  }
  try {
    await getPool('app').query('SELECT app.accept_invitation($1,$2)', [hashToken(token), userId]);
  } catch (e) {
    // The profile did not land: take the auth rows back so the address is not stranded.
    await auth.query('DELETE FROM auth."user" WHERE id=$1', [userId]).catch(() => undefined);
    if ((e as { code?: string }).code === 'P0002')
      throw new InputError('Undangan tidak ditemukan, sudah dipakai, atau kedaluwarsa.');
    throw e;
  }
  return { userId, email: open.email };
}
