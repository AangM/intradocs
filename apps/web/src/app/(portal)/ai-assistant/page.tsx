import { requireActor } from '@/lib/session';
import { PageHeading, Pending } from '@/components/shared';
import { Icon } from '@/components/icon';
import Link from 'next/link';
export default async function Assistant() {
  await requireActor();
  return (
    <div className="pad">
      <PageHeading
        title="AI Assistant"
        subtitle="Jawaban yang nantinya grounded pada dokumen resmi sesuai akses Anda."
        actions={<span className="pill p-grey">Provider: off</span>}
      />
      <Pending milestone="M4">
        Belum ada retrieval, model, penyimpanan chat, atau request cloud. Jangan memasukkan
        pertanyaan internal ke layanan AI pribadi.
      </Pending>
      <section className="chat-placeholder">
        <div className="chat-welcome">
          <span className="logo-mark">
            <Icon name="spark" size={25} />
          </span>
          <h2>Apa yang ingin Anda ketahui?</h2>
          <p className="sub">
            AI belum aktif. Sementara itu, Anda dapat mencari dan membaca dokumen sumber langsung.
          </p>
        </div>
        <div className="grid g2">
          {[
            { q: 'VPN', label: 'Bagaimana konfigurasi VPN?' },
            { q: 'Backup', label: 'Apa kebijakan backup contoh?' },
            { q: 'Monitoring', label: 'Bagaimana memasang monitoring?' },
            { q: 'Repository', label: 'Bagaimana standar branch tim?' },
          ].map((x) => (
            <Link key={x.q} href={`/search?q=${x.q}`} className="card card-b">
              <div className="row">
                <Icon name="search" size={16} />
                <strong>{x.label}</strong>
              </div>
              <p className="sub tiny" style={{ marginTop: 8 }}>
                Buka pencarian metadata, bukan jawaban AI.
              </p>
            </Link>
          ))}
        </div>
        <div className="chat-composer">
          <label htmlFor="question" className="sr-only">
            Pertanyaan AI
          </label>
          <textarea id="question" disabled placeholder="AI belum diaktifkan pada milestone ini…" />
          <footer>
            <span className="sub tiny">
              Sumber akan divalidasi dan mengikuti RBAC. Tanpa sumber, AI harus menyatakan tidak
              tahu.
            </span>
            <button className="btn btn-p" disabled>
              <Icon name="arrow-r" size={16} />
              Kirim
            </button>
          </footer>
        </div>
      </section>
    </div>
  );
}
