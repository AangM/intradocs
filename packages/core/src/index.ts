export const ROLES = [
  'super_admin',
  'knowledge_admin',
  'reviewer',
  'contributor',
  'viewer',
] as const;
export type Role = (typeof ROLES)[number];
export const ROLE_LABELS: Record<Role, string> = {
  super_admin: 'Super Admin',
  knowledge_admin: 'Admin Knowledge',
  reviewer: 'Reviewer',
  contributor: 'Contributor',
  viewer: 'Viewer',
};
export const CLASSIFICATIONS = ['public', 'internal', 'restricted', 'confidential'] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];
export const CLASSIFICATION_LABELS: Record<Classification, string> = {
  public: 'Publik',
  internal: 'Internal',
  restricted: 'Terbatas',
  confidential: 'Rahasia',
};
export const CAPABILITIES = [
  'documents.upload',
  'documents.review',
  'taxonomy.view',
  'users.view',
  'users.manage',
  'audit.view',
  'analytics.view',
] as const;
export type Capability = (typeof CAPABILITIES)[number];
const permissions: Record<Role, readonly Capability[]> = {
  super_admin: CAPABILITIES,
  knowledge_admin: [
    'documents.upload',
    'documents.review',
    'taxonomy.view',
    'users.view',
    'audit.view',
    'analytics.view',
  ],
  reviewer: ['documents.upload', 'documents.review', 'audit.view'],
  contributor: ['documents.upload'],
  viewer: [],
};
export interface Actor {
  id: string;
  name: string;
  email: string;
  role: Role;
  unit: string;
  active: boolean;
  scopeAll: boolean;
}
export function hasCapability(
  actor: Pick<Actor, 'role' | 'active'>,
  capability: Capability,
): boolean {
  return actor.active && permissions[actor.role].includes(capability);
}
export function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/u)
    .slice(0, 2)
    .map((part) => [...part][0] ?? '')
    .join('')
    .toUpperCase();
}
export function formatNumber(value: number): string {
  return new Intl.NumberFormat('id-ID').format(value);
}
export function formatDate(value: string | Date): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('id-ID', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Jakarta',
  }).format(d);
}
export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}
export const FEATURES = Object.freeze({
  uploads: true,
  approvalMutations: true,
  ai: false,
  oidc: false,
  vectorSearch: false,
  roleEditor: false,
});
