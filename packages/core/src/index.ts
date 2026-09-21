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
export const CAPABILITY_LABELS: Record<Capability, string> = {
  'documents.upload': 'Unggah & revisi dokumen',
  'documents.review': 'Review & persetujuan',
  'taxonomy.view': 'Kategori & label',
  'users.view': 'Melihat pengguna',
  'users.manage': 'Mengelola akun',
  'audit.view': 'Audit log',
  'analytics.view': 'Dashboard',
};
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
/** The capabilities a built-in role carries; the ceiling a custom role can only narrow. */
export function roleCapabilities(role: Role): readonly Capability[] {
  return permissions[role];
}
/**
 * A custom role: a name over one built-in base role, minus the capabilities it denies.
 * The database enforces the base role (every policy reads it); the application enforces
 * the denials on every request through hasCapability. A custom role never adds anything.
 */
export interface CustomRole {
  id: string;
  name: string;
  description: string;
  color: string;
  baseRole: Exclude<Role, 'super_admin'>;
  deniedCapabilities: Capability[];
  revision: number;
  holders: number;
}
export const CUSTOM_ROLE_BASES = ['knowledge_admin', 'reviewer', 'contributor', 'viewer'] as const;
export const ROLE_COLORS = ['blue', 'red', 'violet', 'green', 'amber', 'sky'] as const;
export interface Actor {
  id: string;
  name: string;
  email: string;
  /** The built-in role the database enforces; a custom role never changes it. */
  role: Role;
  unit: string;
  active: boolean;
  scopeAll: boolean;
  /** Set when the person holds a custom role: its name is what the UI shows. */
  customRole?: { id: string; name: string } | null;
  /** Effective capabilities: the base role's minus the custom role's denials. */
  capabilities?: readonly Capability[];
}
export function hasCapability(
  actor: Pick<Actor, 'role' | 'active'> & Partial<Pick<Actor, 'capabilities'>>,
  capability: Capability,
): boolean {
  return actor.active && (actor.capabilities ?? permissions[actor.role]).includes(capability);
}
/** What the base role grants minus the denials; the single place that arithmetic lives. */
export function effectiveCapabilities(role: Role, denied: readonly string[]): Capability[] {
  return permissions[role].filter((c) => !denied.includes(c));
}
/** The name a person's role is shown under: the custom role's, else the built-in label. */
export function roleLabel(actor: Pick<Actor, 'role'> & Partial<Pick<Actor, 'customRole'>>): string {
  return actor.customRole?.name ?? ROLE_LABELS[actor.role];
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
/**
 * "4 jam lalu" for lists that scan by recency; the absolute date belongs in a title
 * attribute next to it. Past only; anything older than a month falls back to the date.
 */
export function formatRelative(value: string | Date, now: Date = new Date()): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  const seconds = Math.max(0, Math.round((now.getTime() - d.getTime()) / 1000));
  if (seconds < 60) return 'baru saja';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} menit lalu`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} jam lalu`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'kemarin';
  if (days < 7) return `${days} hari lalu`;
  if (days < 30) return `${Math.round(days / 7)} minggu lalu`;
  return formatDate(d);
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
