import type { CSSProperties } from 'react';
export function Icon({
  name,
  size = 18,
  className = '',
  style,
}: {
  name: string;
  size?: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      className={`i ${className}`}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      style={{ width: size, height: size, ...style }}
      aria-hidden="true"
      focusable="false"
    >
      <use href={`/icons.svg#ic-${name}`} />
    </svg>
  );
}
