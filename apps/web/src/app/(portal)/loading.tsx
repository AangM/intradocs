export default function Loading() {
  return (
    <div className="pad" role="status" aria-live="polite">
      <div className="skeleton" />
      <div className="skeleton small" />
      <p className="sub">Memuat konten sesuai akses Anda…</p>
    </div>
  );
}
