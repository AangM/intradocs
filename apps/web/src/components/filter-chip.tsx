import Link from 'next/link';
import { Icon } from './icon';

/**
 * One filter as a chip with a dropdown of links (mockup S03: "Kategori: Semua ▾"). Built
 * on <details>, so it opens without script, closes on Escape in every browser, and each
 * choice is a real URL. `clearHref` turns the chip into "Label: Runbook ×" when active.
 */
export function FilterChip({
  label,
  value,
  options,
  clearHref,
}: {
  label: string;
  value: string | null;
  options: { label: string; href: string; active?: boolean; count?: number }[];
  clearHref?: string;
}) {
  return (
    <details className={`fchip ${value ? 'on' : ''}`}>
      <summary>
        <span className="fchip-l">{label}:</span> {value ?? 'Semua'}
        {value && clearHref ? (
          <Link href={clearHref} className="fchip-x" aria-label={`Hapus filter ${label}`}>
            <Icon name="x" size={12} />
          </Link>
        ) : (
          <Icon name="chev-d" size={12} />
        )}
      </summary>
      <div className="fchip-menu" role="menu">
        {options.map((o) => (
          <Link
            key={o.href}
            href={o.href}
            role="menuitem"
            className={o.active ? 'on' : ''}
            prefetch={false}
          >
            <span>{o.label}</span>
            {o.count !== undefined && <span className="n">{o.count}</span>}
          </Link>
        ))}
      </div>
    </details>
  );
}
