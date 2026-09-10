'use client';
export default function ErrorPage({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="error-page">
      <h1>Layanan belum siap</h1>
      <p>
        Pastikan setup lokal selesai dan PostgreSQL aktif. Tidak ada detail koneksi atau data
        internal ditampilkan.
      </p>
      <button className="btn btn-p" onClick={reset}>
        Coba lagi
      </button>
    </main>
  );
}
