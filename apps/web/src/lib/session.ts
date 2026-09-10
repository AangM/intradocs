import 'server-only';
import { cache } from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getAuth } from './auth';
import { loadActor, AccessDenied } from '@intradocs/db/queries';
import { hasCapability, type Capability, type Actor } from '@intradocs/core';
export class Unauthenticated extends Error {}
export const currentActor = cache(async (): Promise<Actor | null> => {
  const session = await getAuth().api.getSession({ headers: await headers() });
  return session ? loadActor(session.user.id) : null;
});
export async function requireActor(capability?: Capability): Promise<Actor> {
  const actor = await currentActor();
  if (!actor) redirect('/login');
  if (capability && !hasCapability(actor, capability)) redirect('/akses-ditolak');
  return actor;
}
export async function requireApiActor(capability?: Capability): Promise<Actor> {
  const actor = await currentActor();
  if (!actor) throw new Unauthenticated();
  if (capability && !hasCapability(actor, capability)) throw new AccessDenied();
  return actor;
}
