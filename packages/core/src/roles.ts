import {
  CAPABILITIES,
  CUSTOM_ROLE_BASES,
  ROLE_COLORS,
  roleCapabilities,
  type Role,
} from './index.ts';
import { InputError } from './validation.ts';
import { objectInput } from './workflow.ts';

export function parseRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0)
    throw new InputError('Revisi tidak valid.');
  return value;
}

/**
 * A custom role definition from the client. The denied list is checked against the base
 * role's own capabilities: denying something the base never had is meaningless and is
 * refused rather than stored, so a definition always reads as a true subset.
 */
export function parseCustomRole(value: unknown, withRevision = false) {
  const v = objectInput(value, [
    'name',
    'description',
    'color',
    'baseRole',
    'deniedCapabilities',
    ...(withRevision ? ['revision'] : []),
  ]);
  if (typeof v.name !== 'string' || v.name.trim().length < 2 || v.name.trim().length > 40)
    throw new InputError('Nama role harus 2–40 karakter.');
  if (typeof v.description !== 'string' || v.description.length > 240)
    throw new InputError('Deskripsi maksimal 240 karakter.');
  if (!(ROLE_COLORS as readonly unknown[]).includes(v.color))
    throw new InputError('Warna tidak dikenal.');
  if (!(CUSTOM_ROLE_BASES as readonly unknown[]).includes(v.baseRole))
    throw new InputError('Role dasar tidak valid.');
  const base = v.baseRole as Role;
  if (
    !Array.isArray(v.deniedCapabilities) ||
    v.deniedCapabilities.some(
      (c) =>
        !(CAPABILITIES as readonly unknown[]).includes(c) ||
        !roleCapabilities(base).includes(c as (typeof CAPABILITIES)[number]),
    )
  )
    throw new InputError('Kemampuan yang dicabut harus termasuk kemampuan role dasar.');
  const deniedCapabilities = [...new Set(v.deniedCapabilities as string[])];
  return {
    name: v.name.trim(),
    description: v.description.trim(),
    color: v.color as string,
    baseRole: base,
    deniedCapabilities,
    revision: withRevision ? parseRevision(v.revision) : 0,
  };
}
