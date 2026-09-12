import type { TaxonomyCategory } from '@intradocs/db/taxonomy';
import { CLASSIFICATION_LABELS, type Classification } from '@intradocs/core';
import { Icon } from './icon';

/**
 * The rules that actually apply (mockup S07 "Aturan Otomatis"), read from the same
 * category settings the form edits plus the fixed ones the code enforces. Shown as a
 * summary, not a rule engine: there is no free-form rule builder, and saying so is more
 * useful than a panel that looks configurable and is not.
 */
export function TaxonomyRules({ categories }: { categories: TaxonomyCategory[] }) {
  const perCategory = categories.filter(
    (c) => c.approvalSteps > 1 || c.minimumClassification !== 'internal' || c.reviewDays !== 180,
  );
  return (
    <section className="card mt20" aria-label="Aturan yang berlaku">
      <div className="card-h">
        <Icon name="shield" size={17} />
        <h2 className="h3">Aturan yang berlaku</h2>
      </div>
      <div className="card-b">
        <ul className="rules-list">
          <li>
            <strong>Dokumen berlabel Kritikal</strong> selalu memerlukan persetujuan dua tahap, apa
            pun pengaturan kategorinya.
          </li>
          <li>
            <strong>Klasifikasi minimum kategori</strong> tidak bisa diturunkan tanpa review akses
            terpisah; dokumen Terbatas/Rahasia hanya terbaca lewat grant per dokumen.
          </li>
          <li>
            <strong>Pengingat review</strong> dimulai H−14 sebelum tanggal review kategori; dokumen
            yang lewat tanggal ditandai kedaluwarsa dan dikeluarkan dari index AI.
          </li>
          <li>
            <strong>Label dari AI</strong> hanya diusulkan, disaring kosakata kategori, dan tidak
            pernah diterapkan otomatis — perubahan label lewat revisi yang direview.
          </li>
          {perCategory.map((c) => (
            <li key={c.id}>
              <strong>{c.name}</strong>: minimum{' '}
              {CLASSIFICATION_LABELS[c.minimumClassification as Classification]}, {c.approvalSteps}{' '}
              tahap persetujuan, review tiap {c.reviewDays} hari.
            </li>
          ))}
        </ul>
        <p className="sub tiny">
          Aturan per kategori diubah lewat form kategori di atas; empat aturan pertama ditetapkan di
          kode dan tidak dapat dimatikan dari UI.
        </p>
      </div>
    </section>
  );
}
