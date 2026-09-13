import { requireActor } from '@/lib/session';
import { getAiConfig } from '@/lib/rag';
import { listCategories } from '@intradocs/db/queries';
import { listConversations, listRecentlyReadDocuments } from '@intradocs/db/assistant';
import { AssistantChat } from '@/components/assistant-chat';
import { PageHeading, Pending } from '@/components/shared';
import { Icon } from '@/components/icon';
import Link from 'next/link';
export default async function Assistant({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[]; doc?: string | string[] }>;
}) {
  const actor = await requireActor();
  const config = getAiConfig();
  // A question handed over from the search page is only pre-filled, never sent: the
  // person decides when a (slow, local) generation starts.
  const params = await searchParams;
  const initialQuestion = typeof params.q === 'string' ? params.q.slice(0, 2000) : '';
  // A document handed over from its page pre-selects the "dokumen yang saya buka" scope;
  // it only takes effect if that document is in the actor's own read history.
  const initialDocumentId = typeof params.doc === 'string' ? params.doc : '';
  // With AI off the page keeps the original placeholder, so the portal stays usable
  // exactly as before rather than showing a broken chat box.
  if (config.retrieval === 'weknora-local' && config.weknora) {
    // Scope options come from RLS-filtered tables: the categories this actor sees and
    // the documents they have opened. Neither list can name anything they cannot read.
    const [categories, recentDocuments, conversations] = await Promise.all([
      listCategories(actor.id),
      listRecentlyReadDocuments(actor.id),
      listConversations(actor.id),
    ]);
    return (
      <div className="pad assistant-page">
        <PageHeading
          title="AI Assistant"
          subtitle="Jawaban bersumber dokumen resmi sesuai akses Anda."
          actions={
            <span className="pill p-green">
              {config.generation === 'weknora-local' ? 'Retrieval + jawaban' : 'Retrieval'}: lokal
            </span>
          }
        />
        <AssistantChat
          actorName={actor.name}
          maxQuestionChars={config.weknora.maxQuestionChars}
          generating={config.generation === 'weknora-local'}
          external={config.generationLocation === 'external'}
          starters={[
            'Apakah MFA dibutuhkan saat masuk ke profil VPN laboratorium?',
            'Kapan sebuah backup baru boleh dianggap berhasil?',
            'Apa prasyarat memasang agent monitoring di server laboratorium?',
            'Berapa harga saham perusahaan hari ini?',
          ]}
          categories={categories.map((c) => ({ id: c.id, parentId: c.parentId, name: c.name }))}
          recentDocuments={recentDocuments.map((d) => ({
            id: d.id,
            title: d.title,
            categoryName: d.categoryName,
          }))}
          initialConversations={conversations}
          initialQuestion={initialQuestion}
          initialDocumentId={initialDocumentId}
        />
      </div>
    );
  }
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
