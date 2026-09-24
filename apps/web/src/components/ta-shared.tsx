import type { TaKind } from '@intradocs/core/ta';

/** One sprite icon per kind; the sprite has no dedicated server/network glyphs beyond these. */
export const TA_KIND_ICON: Record<TaKind, string> = {
  location: 'home',
  network_segment: 'branch',
  network_device: 'shield',
  server: 'server',
  storage: 'db',
  virtual_machine: 'layers',
  platform: 'grid',
  software: 'zap',
};

/** End-of-support state as a pill: past (red), within 180 days (amber), otherwise nothing. */
export function TaEosPill({ days }: { days: number | null }) {
  if (days === null || days > 180) return null;
  if (days < 0) return <span className="pill p-red">Lewat {Math.abs(days)} hari</span>;
  return <span className="pill p-amber">{days} hari lagi</span>;
}
