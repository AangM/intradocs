'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ReviewInfo, VersionSummary } from '@intradocs/db/workflow';
import { formatDate, ROLE_LABELS, type Role } from '@intradocs/core';
import { Icon } from './icon';
import { toast } from './toast';

type Finding = { rule: string; severity: string; line: number };
export function WorkflowPanel({
  documentId,
  versionId,
  actorId,
  owner,
  latest,
  status,
  info,
  versions,
  preflight,
  slug,
}: {
  documentId: string;
  versionId: string;
  actorId: string;
  owner: boolean;
  latest: boolean;
  status: string;
  info: ReviewInfo;
  versions: VersionSummary[];
  preflight: Finding[];
  slug: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [error, setError] = useState('');
  const [reviewers, setReviewers] = useState<string[]>([]),
    [reason, setReason] = useState('');
  const [reviewAt, setReviewAt] = useState(''),
    [expiresAt, setExpiresAt] = useState(''),
    [confirmed, setConfirmed] = useState(false);
  const [resolution, setResolution] = useState<Record<string, string>>({});
  async function act(url: string, body: unknown, success: string) {
    if (busy) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const v = await r.json();
      if (!r.ok) throw new Error(v.error ?? 'Perubahan gagal.');
      setMessage(success);
      toast(success);
      router.refresh();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'Koneksi terputus. Muat ulang untuk memeriksa status.',
      );
    } finally {
      setBusy(false);
    }
  }
  const ownStep = info.steps.find((s) => s.reviewerId === actorId && !s.decision);
  const canDecide =
    ownStep &&
    info.state === 'pending' &&
    status === 'in_review' &&
    info.steps.filter((s) => s.stage < ownStep.stage).every((s) => s.decision === 'approve');
  const api = `/api/versions/${versionId}`;
  return (
    <section className="card workflow-panel" aria-label="Versi dan persetujuan">
      <div className="card-h">
        <Icon name="shield" />
        <h2 className="h3">Versi & Persetujuan</h2>
      </div>
      <div className="card-b">
        <details className="version-history">
          <summary>Riwayat versi ({versions.length})</summary>
          <ul>
            {versions.map((v) => (
              <li key={v.id}>
                <Link prefetch={false} href={`/dokumen/${documentId}/${slug}?version=${v.id}`}>
                  v{v.label} · {v.title}
                </Link>{' '}
                <span className="sub">
                  {v.active ? 'Aktif' : v.reviewState} · {formatDate(v.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        </details>
        {info.steps.length > 0 && (
          <ol className="review-timeline">
            {info.steps.map((s) => (
              <li key={s.stage}>
                <strong>
                  Tahap {s.stage} —{' '}
                  {s.decision === 'approve'
                    ? 'Disetujui'
                    : s.decision === 'reject'
                      ? 'Ditolak'
                      : s.decision === 'changes_requested'
                        ? 'Minta revisi'
                        : 'Menunggu'}
                </strong>
                {s.reason && <p>{s.reason}</p>}
                {s.decidedAt && <span className="sub">{formatDate(s.decidedAt)}</span>}
              </li>
            ))}
          </ol>
        )}
        {info.outbox && (
          <p className="callout c-info">
            <span>
              Publikasi:{' '}
              <strong>
                {
                  (
                    {
                      pending: 'Menunggu worker',
                      running: 'Membangun indeks',
                      done: 'Indeks siap',
                      dead: 'Gagal setelah batas retry',
                      cancelled: 'Dibatalkan; review/versi perlu diperbarui',
                    } as Record<string, string>
                  )[info.outbox.state]
                }
              </strong>
              . Percobaan {info.outbox.attempts}/5. Versi lama yang masih sah tetap aktif sampai
              publikasi baru selesai.
            </span>
          </p>
        )}
        {status === 'draft' && owner && latest && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void act(
                api + '/submit',
                { reviewers, reviewAt, expiresAt, confirmed },
                'Versi dibekukan dan diajukan ke reviewer.',
              );
            }}
          >
            <h3>Ajukan untuk persetujuan</h3>
            <p className="sub">
              {info.requiredSteps} tahap wajib. Reviewer harus berbeda dan bukan penulis. Periksa
              seluruh sumber sebelum mengajukan.
            </p>
            {preflight.length > 0 && (
              <div className="callout c-warn">
                <div>
                  <strong>Temuan prapemeriksaan</strong>
                  <ul>
                    {preflight.map((f, i) => (
                      <li key={i}>
                        {f.rule} · baris {f.line} ·{' '}
                        {f.severity === 'block'
                          ? 'Wajib dihapus lewat revisi'
                          : 'Perlu justifikasi reviewer'}
                      </li>
                    ))}
                  </ul>
                  <p>Pemeriksaan pola terbatas, bukan jaminan DLP.</p>
                </div>
              </div>
            )}
            <fieldset disabled={busy} className="workflow-fields">
              {Array.from({ length: info.requiredSteps }, (_, i) => (
                <label key={i}>
                  Reviewer tahap {i + 1}
                  <select
                    className="inp"
                    value={reviewers[i] ?? ''}
                    required
                    onChange={(e) =>
                      setReviewers((a) =>
                        Array.from({ length: info.requiredSteps }, (_, j) =>
                          j === i ? e.target.value : (a[j] ?? ''),
                        ),
                      )
                    }
                  >
                    <option value="">Pilih reviewer</option>
                    {info.candidates.map((c) => (
                      <option
                        key={c.id}
                        value={c.id}
                        disabled={reviewers.some((id, j) => j !== i && id === c.id)}
                      >
                        {c.name} · {ROLE_LABELS[c.role as Role] ?? c.role}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
              <div className="grid g2">
                <label>
                  Review berikutnya
                  <input
                    className="inp"
                    type="date"
                    value={reviewAt}
                    onChange={(e) => setReviewAt(e.target.value)}
                  />
                  <span className="hint">Kosong: gunakan aturan kategori.</span>
                </label>
                <label>
                  Kedaluwarsa (opsional)
                  <input
                    className="inp"
                    type="date"
                    value={expiresAt}
                    onChange={(e) => setExpiresAt(e.target.value)}
                  />
                </label>
              </div>
              <label className="upload-check">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                  required
                />
                <span>
                  Saya telah membandingkan Markdown, original, dan lampiran. Reviewer terpilih akan
                  mendapat akses versi ini.
                </span>
              </label>
              <button
                className="btn btn-p"
                disabled={
                  !confirmed ||
                  preflight.some((f) => f.severity === 'block') ||
                  info.candidates.length < info.requiredSteps
                }
              >
                Ajukan review
              </button>
            </fieldset>
            {info.candidates.length < info.requiredSteps && (
              <p role="status">
                Reviewer berizin belum mencukupi. Minta pengelola memeriksa scope atau grant akses.
              </p>
            )}
          </form>
        )}
        {info.findings.length > 0 && (
          <div>
            <h3>Temuan keamanan</h3>
            {info.findings.map((f, i) => (
              // Two matches of one rule on one line share a fingerprint; the index keeps
              // the key unique without changing what the fingerprint means.
              <div className="finding" key={`${f.fingerprint}-${i}`}>
                <strong>
                  {f.rule} · baris {f.line}
                </strong>
                <p>{f.resolved ? 'Selesai: ' + f.justification : 'Belum diselesaikan'}</p>
                {canDecide && !f.resolved && f.severity === 'review' && (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void act(
                        api + '/findings',
                        { fingerprint: f.fingerprint, reason: resolution[f.fingerprint] },
                        'Justifikasi dicatat.',
                      );
                    }}
                  >
                    <label>
                      Justifikasi false positive
                      <textarea
                        className="inp"
                        required
                        minLength={10}
                        maxLength={2000}
                        value={resolution[f.fingerprint] ?? ''}
                        onChange={(e) =>
                          setResolution((a) => ({ ...a, [f.fingerprint]: e.target.value }))
                        }
                      />
                    </label>
                    <button className="btn" disabled={busy}>
                      Catat justifikasi
                    </button>
                  </form>
                )}
              </div>
            ))}
          </div>
        )}
        {canDecide && (
          <div className="decision-form">
            <label>
              Catatan review
              <textarea
                className="inp"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={2000}
                placeholder="Wajib minimal 10 karakter untuk minta revisi atau tolak."
              />
            </label>
            <div className="row wrap">
              <button
                className="btn btn-r"
                disabled={busy || reason.trim().length < 10}
                onClick={() =>
                  void act(api + '/decision', { decision: 'reject', reason }, 'Pengajuan ditolak.')
                }
              >
                Tolak
              </button>
              <button
                className="btn"
                disabled={busy || reason.trim().length < 10}
                onClick={() =>
                  void act(
                    api + '/decision',
                    { decision: 'changes_requested', reason },
                    'Permintaan revisi dikirim.',
                  )
                }
              >
                Minta revisi
              </button>
              <button
                className="btn btn-g"
                disabled={busy || info.findings.some((f) => !f.resolved)}
                onClick={() =>
                  void act(
                    api + '/decision',
                    { decision: 'approve', reason },
                    ownStep.stage === info.requiredSteps
                      ? 'Disetujui; menunggu publikasi worker.'
                      : 'Tahap ini disetujui; menunggu reviewer berikutnya.',
                  )
                }
              >
                {ownStep.stage === info.requiredSteps
                  ? 'Setujui & proses publikasi'
                  : 'Setujui tahap ini'}
              </button>
            </div>
          </div>
        )}
        {ownStep && !canDecide && status === 'in_review' && (
          <p className="sub">Menunggu persetujuan tahap sebelumnya.</p>
        )}
        {owner && latest && status !== 'withdrawn' && (
          <div className="row wrap mt20">
            <Link className="btn" href={`/unggah?document=${documentId}&base=${versionId}`}>
              Buat revisi baru
            </Link>
            {info.outbox?.state === 'dead' && (
              <button
                className="btn"
                disabled={busy}
                onClick={() => void act(api + '/retry', {}, 'Publikasi dijadwalkan ulang.')}
              >
                Coba ulang publikasi
              </button>
            )}
          </div>
        )}
        {owner && status !== 'withdrawn' && (
          <details className="withdraw-panel">
            <summary>Cabut dokumen dari publikasi</summary>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void act(
                  `/api/documents/${documentId}/withdraw`,
                  { reason },
                  'Dokumen dicabut dari discovery.',
                );
              }}
            >
              <p>
                Seluruh versi berhenti tersedia untuk pembaca. Tindakan ini tidak menghapus audit
                atau original.
              </p>
              <label>
                Alasan pencabutan
                <textarea
                  className="inp"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  required
                  minLength={10}
                  maxLength={2000}
                />
              </label>
              <button className="btn btn-r" disabled={busy}>
                Konfirmasi cabut dokumen
              </button>
            </form>
          </details>
        )}
        {error && (
          <p role="alert" className="inline-error">
            {error}
          </p>
        )}
        {message && (
          <p role="status" className="success-message">
            {message}
          </p>
        )}
        {busy && <p role="status">Menyimpan perubahan…</p>}
      </div>
    </section>
  );
}
