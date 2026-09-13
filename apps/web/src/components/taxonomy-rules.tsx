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
        <h2 className="h3">Aturan otomatis</h2>
        <span className="pill p-green ml-auto">{4 + perCategory.length} aturan aktif</span>
      </div>
      <div className="card-b rules">
        {[
          <>
            Dokumen berlabel <strong>Kritikal</strong> → wajib persetujuan 2 tahap, apa pun
            pengaturan kategorinya
          </>,
          <>
            <strong>Klasifikasi minimum kategori</strong> tidak bisa diturunkan tanpa review akses;
            Terbatas/Rahasia hanya terbaca lewat grant per dokumen
          </>,
          <>
            Dokumen lewat tanggal review → status <strong>Kedaluwarsa</strong>, keluar dari index
            AI; pengingat mulai H−14
          </>,
          <>
            <strong>Label dari AI</strong> hanya diusulkan dan disaring kosakata kategori — tidak
            pernah diterapkan otomatis
          </>,
        ].map((rule, i) => (
          <div className="rule-row" key={i}>
            <span className="ck y" aria-hidden="true">
              <Icon name="check" size={12} />
            </span>
            <span className="rule-t">{rule}</span>
            <span className="sub tiny">di kode</span>
          </div>
        ))}
        {perCategory.map((c) => (
          <div className="rule-row" key={c.id}>
            <span className="ck y" aria-hidden="true">
              <Icon name="check" size={12} />
            </span>
            <span className="rule-t">
              Kategori <strong>{c.name}</strong> → minimum{' '}
              {CLASSIFICATION_LABELS[c.minimumClassification as Classification]}, {c.approvalSteps}{' '}
              tahap persetujuan, review tiap {c.reviewDays} hari
            </span>
            <span className="sub tiny">per kategori</span>
          </div>
        ))}
        <p className="hint">
          Aturan per kategori diubah lewat form kategori; yang bertanda “di kode” tidak dapat
          dimatikan dari UI. Ini ringkasan yang berlaku, bukan rule builder.
        </p>
      </div>
    </section>
  );
}
