import Link from 'next/link';
import { requireActor } from '@/lib/session';
import { Empty } from '@/components/shared';
export default async function Denied() {
  await requireActor();
  return (
    <div className="pad">
      <Empty title="Akses tidak tersedia">
        Akun ini tidak memiliki kemampuan yang diperlukan untuk halaman tersebut. Mengganti URL
        tidak menambah izin.
      </Empty>
      <div style={{ textAlign: 'center' }}>
        <Link href="/help-center" className="btn btn-p">
          Kembali ke Help Center
        </Link>
      </div>
    </div>
  );
}
