'use client';
import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ReviewInfo, ApprovalQueueItem } from '@intradocs/db/workflow';
import { formatDate, formatRelative, initials } from '@intradocs/core';
import { Icon } from './icon';
import { toast } from './toast';
import { ClassificationBadge, CategoryTag } from './shared';

/**
 * The reviewer's side of one submission (mockup S06): header with the three decisions,
 * pre-check findings, converted preview, and the approval timeline. Every action posts
 * to the same endpoints as the reader's WorkflowPanel; the server re-checks the stage,
 * the scope and the findings, so this component only decides what to show.
 */
export function ApprovalDetail({
  item,
  actorId,
  info,
  source,
  attachments,
  preview,
  href,
}: {
  item: ApprovalQueueItem;
  actorId: string;
  info: ReviewInfo;
  source: { name: string; format: string; bytes: number; scannerVersion: string } | null;
  attachments: { ordinal: number; name: string; format: string; bytes: number }[];
  preview: ReactNode;
  href: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [error, setError] = useState(''),
    [reason, setReason] = useState(''),
    [resolution, setResolution] = useState<Record<string, string>>({});
  const api = `/api/versions/${item.versionId}`;
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
    !!ownStep &&
    info.state === 'pending' &&
    info.steps.filter((s) => s.stage < ownStep.stage).every((s) => s.decision === 'approve');
  const open = info.findings.filter((f) => !f.resolved);
  const blocking = info.findings.some((f) => !f.resolved && f.severity === 'block');
  const finalStage = ownStep?.stage === info.requiredSteps;
  const needsReason = reason.trim().length < 10;
  const decide = (decision: 'approve' | 'reject' | 'changes_requested') =>
    void act(
      api + '/decision',
      { decision, reason },
      decision === 'approve'
        ? finalStage
          ? 'Disetujui; publikasi dan indeks dijadwalkan ke worker.'
          : 'Tahap ini disetujui; menunggu reviewer berikutnya.'
        : decision === 'reject'
          ? 'Pengajuan ditolak.'
          : 'Permintaan revisi dikirim ke kontributor.',
    );

  const stepLabel = (s: ReviewInfo['steps'][number]) =>
    s.reviewerId === actorId ? 'Anda' : (s.reviewerName ?? `Reviewer tahap ${s.stage}`);
  const stepState = (s: ReviewInfo['steps'][number]) =>
    s.decision === 'approve'
      ? 'ok'
      : s.decision
        ? 'no'
        : ownStep && s.stage === ownStep.stage && canDecide
          ? 'now'
          : '';
  const stepText = (s: ReviewInfo['steps'][number]) =>
    s.decision === 'approve'
      ? `disetujui · ${formatDate(s.decidedAt!)}`
      : s.decision === 'reject'
        ? `ditolak · ${formatDate(s.decidedAt!)}`
        : s.decision === 'changes_requested'
          ? `minta revisi · ${formatDate(s.decidedAt!)}`
          : ownStep && s.stage === ownStep.stage
            ? canDecide
              ? 'menunggu tindakan Anda'
              : 'menunggu tahap sebelumnya'
            : 'belum mulai';
  const outbox = info.outbox;

  return (
    <div className="appr-detail">
      <div className="appr-head">
        <div className="appr-head-text">
          <nav className="crumbs" aria-label="Breadcrumb">
            <Link href="/admin/approval">Antrean Persetujuan</Link>
            <Icon name="chev-r" size={12} />
            <span>Pengajuan v{item.versionLabel}</span>
          </nav>
          <h1 className="h1">{item.title}</h1>
          <div className="appr-pills">
            {canDecide ? (
              <span className="pill p-amber">
                <Icon name="clock" size={13} /> Menunggu persetujuan Anda
              </span>
            ) : ownStep ? (
              <span className="pill p-grey">
                <Icon name="clock" size={13} /> Menunggu tahap sebelumnya
              </span>
            ) : (
              <span className="pill p-grey">Tahap Anda sudah diputuskan</span>
            )}
            <CategoryTag name={item.categoryName} color={item.categoryColor} />
            <ClassificationBadge value={item.classification as never} />
            {item.labels.map((l) => (
              <span className="tag" key={l}>
                {l}
              </span>
            ))}
            <span className="sub tiny">
              v{item.versionLabel} · diajukan{' '}
              <time dateTime={item.submittedAt} title={formatDate(item.submittedAt)}>
                {formatRelative(item.submittedAt)}
              </time>{' '}
              oleh {item.ownerLabel}
            </span>
          </div>
        </div>
        {canDecide && (
          <div className="appr-actions">
            <button
              className="btn btn-r"
              disabled={busy || needsReason}
              title={needsReason ? 'Isi catatan minimal 10 karakter' : undefined}
              onClick={() => decide('reject')}
            >
              <Icon name="x" size={14} /> Tolak
            </button>
            <button
              className="btn"
              disabled={busy || needsReason}
              title={needsReason ? 'Isi catatan minimal 10 karakter' : undefined}
              onClick={() => decide('changes_requested')}
            >
              <Icon name="refresh" size={14} /> Minta revisi
            </button>
            <button
              className="btn btn-g"
              disabled={busy || open.length > 0}
              title={open.length ? 'Selesaikan temuan keamanan dulu' : undefined}
              onClick={() => decide('approve')}
            >
              <Icon name="check" size={14} />{' '}
              {finalStage ? 'Setujui & publikasikan' : 'Setujui tahap ini'}
            </button>
          </div>
        )}
      </div>

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

      <div className="appr-cols">
        <div className="appr-main">
          <section className="card mb">
            <div className="card-h">
              <Icon name="shield" style={{ color: 'var(--violet)' }} />
              <h2 className="h3">Pra-pemeriksaan</h2>
              <span className={`pill ${open.length ? 'p-amber' : 'p-green'} ml-auto`}>
                {open.length
                  ? `${open.length} temuan perlu ditinjau`
                  : info.findings.length
                    ? 'Semua temuan diselesaikan'
                    : 'Tidak ada temuan'}
              </span>
            </div>
            <div className="card-b precheck">
              <div className="precheck-row">
                <span className="ck y">
                  <Icon name="check" size={12} />
                </span>
                <div>
                  <div className="precheck-t">Dipindai dan dikonversi</div>
                  <div className="precheck-d">
                    {source
                      ? `${source.name} · ${source.format} · ${(source.bytes / 1024).toFixed(0)} KiB · ClamAV ${source.scannerVersion} bersih`
                      : 'Sumber Markdown; canonical dibuat tanpa konversi.'}
                    {attachments.length ? ` · ${attachments.length} lampiran ikut dipindai` : ''}
                  </div>
                </div>
              </div>
              {info.findings.map((f, i) => (
                <div className="precheck-row" key={`${f.fingerprint}-${i}`}>
                  <span className={`ck ${f.resolved ? 'y' : f.severity === 'block' ? 'n' : 'p'}`}>
                    <Icon name={f.resolved ? 'check' : 'alert'} size={12} />
                  </span>
                  <div className="precheck-body">
                    <div className="precheck-t">
                      {f.rule} · baris {f.line}
                    </div>
                    <div className="precheck-d">
                      {f.resolved
                        ? `Dijustifikasi: ${f.justification}`
                        : f.severity === 'block'
                          ? 'Wajib dihapus lewat revisi; tidak bisa dijustifikasi.'
                          : 'Pola sensitif terdeteksi. Justifikasi bila false positive, atau minta revisi.'}
                    </div>
                    {canDecide && !f.resolved && f.severity === 'review' && (
                      <form
                        className="precheck-form"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void act(
                            api + '/findings',
                            { fingerprint: f.fingerprint, reason: resolution[f.fingerprint] },
                            'Justifikasi dicatat.',
                          );
                        }}
                      >
                        <input
                          className="inp"
                          required
                          minLength={10}
                          maxLength={2000}
                          placeholder="Justifikasi false positive (minimal 10 karakter)"
                          value={resolution[f.fingerprint] ?? ''}
                          onChange={(e) =>
                            setResolution((a) => ({ ...a, [f.fingerprint]: e.target.value }))
                          }
                        />
                        <button className="btn btn-sm" disabled={busy}>
                          Catat
                        </button>
                      </form>
                    )}
                  </div>
                  <Link className="btn btn-sm" href={href} prefetch={false}>
                    Lihat
                  </Link>
                </div>
              ))}
              <p className="hint">
                Pemeriksaan otomatis hanya mencari pola kredensial/kunci; isi dan struktur tetap
                Anda nilai.
              </p>
            </div>
          </section>

          <section className="card">
            <div className="card-h">
              <Icon name="file" style={{ color: 'var(--blue-600)' }} />
              <h2 className="h3">Pratinjau dokumen</h2>
              <div className="row ml-auto" style={{ gap: 6 }}>
                <span className="btn btn-sm btn-p" aria-current="true">
                  Hasil konversi
                </span>
                {source && (
                  <a className="btn btn-sm" href={`/api/files/${item.versionId}/original`}>
                    Berkas asli
                  </a>
                )}
                <Link className="btn btn-sm" href={href} prefetch={false}>
                  Buka lengkap <Icon name="arrow-r" size={13} />
                </Link>
              </div>
            </div>
            <div className="card-b">
              <div className="preview-doc appr-preview">{preview}</div>
              <div className="row wrap appr-files">
                {source && (
                  <a className="tag" href={`/api/files/${item.versionId}/original`}>
                    <Icon name="file" size={13} /> {source.name} ·{' '}
                    {(source.bytes / 1024).toFixed(0)} KiB
                  </a>
                )}
                {attachments.map((a) => (
                  <a
                    className="tag"
                    key={a.ordinal}
                    href={`/api/files/${item.versionId}/attachments/${a.ordinal}`}
                  >
                    <Icon name="file" size={13} /> {a.name} · {(a.bytes / 1024).toFixed(0)} KiB
                  </a>
                ))}
                <a className="btn btn-sm ml-auto" href={`/api/files/${item.versionId}/markdown`}>
                  <Icon name="download" size={14} /> Unduh Markdown
                </a>
              </div>
            </div>
          </section>
        </div>

        <div className="appr-side" role="group" aria-label="Alur, catatan, dan tindak lanjut">
          <section className="card mb">
            <div className="card-h">
              <h2 className="h3">Alur persetujuan</h2>
            </div>
            <div className="card-b">
              <div className="timeline">
                <div className="tl-i ok">
                  <div className="t">Diajukan</div>
                  <div className="d">
                    {item.ownerLabel} · {formatDate(item.submittedAt)}
                  </div>
                </div>
                <div className={`tl-i ${open.length ? 'now' : 'ok'}`}>
                  <div className="t">Pra-pemeriksaan otomatis</div>
                  <div className="d">
                    Sistem ·{' '}
                    {info.findings.length
                      ? `${info.findings.length} temuan, ${open.length} terbuka`
                      : 'tidak ada temuan'}
                  </div>
                </div>
                {info.steps.map((s) => (
                  <div className={`tl-i ${stepState(s)}`} key={s.stage}>
                    <div className="t">
                      Review tahap {s.stage} dari {info.requiredSteps}
                    </div>
                    <div className="d">
                      {stepLabel(s)} · {stepText(s)}
                    </div>
                    {s.reason && <div className="d tl-reason">“{s.reason}”</div>}
                  </div>
                ))}
                <div
                  className={`tl-i ${outbox?.state === 'done' ? 'ok' : outbox ? 'now' : ''}`}
                  style={{ paddingBottom: 0 }}
                >
                  <div className="t">Publikasi & indeks AI</div>
                  <div className="d">
                    {outbox
                      ? (
                          {
                            pending: 'Menunggu worker',
                            running: 'Membangun indeks',
                            done: 'Indeks siap',
                            dead: 'Gagal setelah batas retry',
                            cancelled: 'Dibatalkan',
                          } as Record<string, string>
                        )[outbox.state]
                      : 'Otomatis setelah persetujuan final'}
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section className="card mb">
            <div className="card-h">
              <h2 className="h3">Catatan reviewer</h2>
            </div>
            <div className="card-b">
              {info.steps
                .filter((s) => s.reason)
                .map((s) => (
                  <div className="note-bubble" key={s.stage}>
                    <div className="row" style={{ gap: 7, marginBottom: 4 }}>
                      <span className="avatar avatar-xs">{initials(stepLabel(s))}</span>
                      <strong className="tiny">{stepLabel(s)}</strong>
                      <span className="sub tiny">
                        {s.decidedAt ? formatRelative(s.decidedAt) : ''}
                      </span>
                    </div>
                    <div className="note-text">{s.reason}</div>
                  </div>
                ))}
              {canDecide ? (
                <>
                  <textarea
                    className="inp"
                    rows={3}
                    maxLength={2000}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="Catatan untuk kontributor — wajib minimal 10 karakter untuk minta revisi atau tolak."
                    aria-label="Catatan review"
                  />
                  <p className="hint">
                    Catatan tersimpan pada keputusan dan tampak bagi pemilik dokumen.
                  </p>
                </>
              ) : (
                <p className="sub tiny">
                  {ownStep
                    ? 'Anda bisa memberi catatan setelah tahap sebelumnya disetujui.'
                    : 'Tidak ada tindakan yang menunggu Anda pada versi ini.'}
                </p>
              )}
            </div>
          </section>

          <section className="card">
            <div className="card-h">
              <h2 className="h3">Setelah disetujui</h2>
            </div>
            <div className="card-b precheck">
              <div className="precheck-row">
                <span className="ck y">
                  <Icon name="check" size={12} />
                </span>
                <div className="precheck-d">
                  Dokumen terbit otomatis; versi lama tetap bisa dibaca sampai selesai.
                </div>
              </div>
              <div className="precheck-row">
                <span className="ck y">
                  <Icon name="check" size={12} />
                </span>
                <div className="precheck-d">
                  Masuk ke AI Assistant — hanya versi yang sudah disetujui penuh yang bisa dikutip.
                </div>
              </div>
              <div className="precheck-row">
                <span className="ck y">
                  <Icon name="check" size={12} />
                </span>
                <div className="precheck-d">Keputusan, alasan, dan nama reviewer tercatat.</div>
              </div>
              {blocking && (
                <p className="callout c-warn">
                  <Icon name="alert" size={15} />
                  <span>Ada temuan yang wajib dihapus lewat revisi; persetujuan diblokir.</span>
                </p>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
