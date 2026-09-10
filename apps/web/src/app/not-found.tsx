import Link from 'next/link';
export default function NotFound() {
  return (
    <main className="error-page">
      <h1>Halaman tidak tersedia</h1>
      <p>Halaman tidak ditemukan atau tidak dapat diakses oleh akun Anda.</p>
      <Link className="btn btn-p" href="/help-center">
        Kembali ke Help Center
      </Link>
    </main>
  );
}
