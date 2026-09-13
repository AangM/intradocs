'use client';
import { useRouter } from 'next/navigation';

/**
 * A sort control that navigates on change. Each option is a full URL, so the sort is
 * bookmarkable and works as a plain link list when JavaScript is off (the <noscript>
 * fallback below).
 */
export function SortSelect({
  value,
  options,
}: {
  value: string;
  /** [value, label, href]: a server component computes every URL up front. */
  options: ReadonlyArray<readonly [string, string, string]>;
}) {
  const router = useRouter();
  const hrefFor = (v: string) => options.find((o) => o[0] === v)?.[2] ?? '#';
  return (
    <>
      <select
        className="inp inp-sm sort-select"
        value={value}
        aria-label="Urutkan hasil"
        onChange={(e) => router.push(hrefFor(e.target.value))}
      >
        {options.map(([v, label]) => (
          <option key={v} value={v}>
            {label}
          </option>
        ))}
      </select>
      <noscript>
        {options.map(([v, label]) => (
          <a key={v} className="btn btn-sm" href={hrefFor(v)}>
            {label}
          </a>
        ))}
      </noscript>
    </>
  );
}
