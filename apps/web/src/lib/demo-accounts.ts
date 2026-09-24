import 'server-only';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { getPool } from '@intradocs/db';
import { ROLE_LABELS, isRole } from '@intradocs/core';

export interface DemoAccountCredential {
  email: string;
  password: string;
}
export interface DemoAccountChoice {
  email: string;
  name: string;
  roleLabel: string;
}

/** var/demo-accounts.json, written by the seed; synthetic @example.test addresses only. */
async function credentials(): Promise<DemoAccountCredential[]> {
  const root = process.env.INTRADOCS_ROOT ?? process.cwd();
  try {
    const raw = JSON.parse(await readFile(path.join(root, 'var/demo-accounts.json'), 'utf8'));
    return (Array.isArray(raw) ? raw : []).filter(
      (a: unknown): a is DemoAccountCredential =>
        !!a &&
        typeof (a as DemoAccountCredential).email === 'string' &&
        typeof (a as DemoAccountCredential).password === 'string' &&
        /^[a-z0-9._-]+@example\.test$/.test((a as DemoAccountCredential).email),
    );
  } catch {
    return [];
  }
}

/** The accounts offered on the login page: active, in role order, without passwords. */
export async function demoAccountChoices(): Promise<DemoAccountChoice[]> {
  const accounts = await credentials();
  if (!accounts.length) return [];
  const { rows } = await getPool('auth').query<{ email: string; name: string }>(
    'SELECT email,name FROM auth."user" WHERE email=ANY($1::text[])',
    [accounts.map((a) => a.email)],
  );
  const names = new Map(rows.map((r) => [r.email, r.name]));
  const roles = await getPool()
    .query<{ email: string; role: string; active: boolean }>(
      'SELECT email,role,active FROM app.demo_account_roles($1::text[])',
      [accounts.map((a) => a.email)],
    )
    .catch(() => ({ rows: [] as Array<{ email: string; role: string; active: boolean }> }));
  const order = ['super_admin', 'knowledge_admin', 'reviewer', 'contributor', 'viewer'];
  return roles.rows
    .filter((r) => r.active && isRole(r.role) && names.has(r.email))
    .sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role) || a.email.localeCompare(b.email))
    .map((r) => ({
      email: r.email,
      name: names.get(r.email)!,
      roleLabel: ROLE_LABELS[r.role as keyof typeof ROLE_LABELS],
    }));
}

export async function demoCredential(email: string): Promise<DemoAccountCredential | null> {
  return (await credentials()).find((a) => a.email === email) ?? null;
}
