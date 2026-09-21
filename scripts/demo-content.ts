/**
 * Demo content, through the real application.
 *
 *   pnpm demo:content
 *
 * Fills every page of the portal with synthetic material so a walkthrough never lands on
 * an empty state: documents in all six categories and in every format the converter
 * takes (MD, TXT, HTML, DOCX, XLSX, PDF), items waiting in both reviewers' queues, a
 * revision request, a rejection, an unsubmitted draft, reader feedback for owners,
 * pending access requests for the admin, required reading with a due date, favourites
 * and read history for a viewer, and a couple of assistant conversations.
 *
 * Nothing is inserted behind the application's back: every document goes through
 * upload → scan → convert → submit → decision → publish, with the same RLS and audit
 * trail a person would leave. That is slower than SQL and the point: the demo shows
 * real rows. Re-running is safe -- a title that already exists is skipped.
 *
 * All text is synthetic and says so; no real policy, person, or credential appears.
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';
import { ROOT, loadLocalEnv, localAdminUrl, reportFailure } from './shared.ts';
import { IDS } from '../fixtures/data.ts';

loadLocalEnv();
const base = process.env.APP_URL!;
const db = new Pool({ connectionString: localAdminUrl(), max: 1 });
const accounts = JSON.parse(
  await readFile(path.join(ROOT, 'var/demo-accounts.json'), 'utf8'),
) as Array<{ id: string; email: string; password: string }>;
const cookies = new Map<string, string>();

async function login(id: string): Promise<string> {
  if (cookies.has(id)) return cookies.get(id)!;
  await db.query('DELETE FROM auth."rateLimit"');
  const a = accounts.find((x) => x.id === id)!;
  const r = await fetch(`${base}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: a.email, password: a.password }),
  });
  if (!r.ok) throw new Error(`login ${a.email}: HTTP ${r.status}`);
  const cookie = r.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  cookies.set(id, cookie);
  return cookie;
}
async function api(actor: string, route: string, body?: unknown, method = 'POST') {
  const r = await fetch(base + route, {
    method,
    headers: {
      Cookie: await login(actor),
      Origin: base,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}

type Fixture = { file: string; mime: string };
const FIXTURES: Record<string, Fixture> = {
  DOCX: {
    file: 'panduan-demo.docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  },
  XLSX: {
    file: 'sla-demo.xlsx',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  },
  PDF: { file: 'panduan-demo.pdf', mime: 'application/pdf' },
  PDF2: { file: 'multikolom-demo.pdf', mime: 'application/pdf' },
};

type Doc = {
  title: string;
  summary: string;
  category: string;
  owner: string;
  classification?: 'public' | 'internal' | 'restricted';
  labels: string[];
  /** Markdown/TXT/HTML text, or a fixture key for binary formats. */
  body: string;
  format: 'MD' | 'TXT' | 'HTML' | 'DOCX' | 'XLSX' | 'PDF' | 'PDF2';
  /** What happens after upload. */
  outcome: 'publish' | 'in_review' | 'changes' | 'reject' | 'draft';
  reviewers?: string[];
};

const NOTE =
  '> DATA SINTETIS — untuk pengujian IntraDocs. Bukan kebijakan resmi atau instruksi operasional.\n\n';

const DOCS: Doc[] = [
  // ---- Onboarding & SDM (was empty) ----
  {
    title: 'Panduan Hari Pertama Karyawan Baru TI',
    summary: 'Apa yang perlu disiapkan dan dilakukan pada hari pertama bergabung di Divisi TI.',
    category: IDS.onboarding,
    owner: IDS.admin,
    labels: ['Onboarding', 'Panduan'],
    format: 'MD',
    outcome: 'publish',
    reviewers: [IDS.super],
    body:
      NOTE +
      `# Panduan Hari Pertama Karyawan Baru TI

## Sebelum datang

- Konfirmasi jadwal orientasi dari tim SDM (pukul 08.30, ruang rapat lantai 3).
- Bawa kartu identitas untuk pembuatan kartu akses gedung.

## Hari pertama

1. Terima laptop kerja dan tanda tangani berita acara serah terima.
2. Aktifkan akun email dan atur MFA pada aplikasi authenticator.
3. Ikuti sesi pengenalan struktur Divisi TI (60 menit).
4. Baca dokumen bacaan wajib di portal ini dan konfirmasi setelah selesai.

## Minggu pertama

| Hari | Kegiatan | Penanggung jawab |
| --- | --- | --- |
| 1 | Orientasi & perangkat | SDM |
| 2 | Pengenalan sistem tiket | Tim Aplikasi Internal |
| 3 | Pelatihan keamanan dasar | Keamanan Informasi |
| 4–5 | Pendampingan mentor | Kepala tim |

## Kontak

Pertanyaan tentang perangkat diajukan lewat portal tiket; pertanyaan tentang kepegawaian ke tim SDM.
`,
  },
  {
    title: 'Checklist Perangkat Kerja & Akun',
    summary:
      'Daftar periksa perangkat, akun, dan akses yang harus siap sebelum karyawan mulai bekerja.',
    category: IDS.onboarding,
    owner: IDS.admin,
    labels: ['Onboarding', 'Checklist'],
    format: 'MD',
    outcome: 'publish',
    reviewers: [IDS.super],
    body:
      NOTE +
      `# Checklist Perangkat Kerja & Akun

## Perangkat

- [ ] Laptop dengan enkripsi disk aktif
- [ ] Kunci keamanan fisik (bila peran memerlukan)
- [ ] Headset untuk rapat daring

## Akun

- [ ] Email dan kalender
- [ ] Akun portal tiket
- [ ] Akun VPN laboratorium (lihat panduan konfigurasi VPN)
- [ ] Repositori kode sesuai tim

## Akses fisik

- [ ] Kartu akses gedung
- [ ] Akses ruang server hanya untuk tim Infrastruktur, setelah pelatihan keselamatan

Semua item dicentang oleh kepala tim dan dilaporkan ke SDM paling lambat hari ke-5.
`,
  },
  {
    title: 'Kebijakan Kerja Hybrid Divisi TI',
    summary: 'Ketentuan hari kerja di kantor dan jarak jauh, jam inti, dan etika rapat daring.',
    category: IDS.onboarding,
    owner: IDS.admin,
    labels: ['Kebijakan'],
    format: 'TXT',
    outcome: 'publish',
    reviewers: [IDS.super],
    body: `DATA SINTETIS - untuk pengujian IntraDocs. Bukan kebijakan resmi.

KEBIJAKAN KERJA HYBRID DIVISI TI

1. Hari di kantor
   Minimal dua hari per minggu, salah satunya hari Selasa (hari koordinasi divisi).

2. Jam inti
   Pukul 10.00 - 15.00 setiap anggota tim dapat dihubungi.

3. Rapat daring
   - Kamera dinyalakan saat presentasi.
   - Agenda dibagikan minimal satu jam sebelumnya.
   - Notulen ditulis di portal, bukan di chat.

4. Peralatan
   Laptop kerja tidak boleh dipakai anggota keluarga. Jaringan rumah wajib memakai VPN
   untuk mengakses sistem internal.

5. Pengecualian
   Diajukan ke kepala tim, dicatat di sistem kepegawaian.
`,
  },
  {
    title: 'Jadwal Pelatihan Wajib Kuartal Ini',
    summary:
      'Sesi pelatihan yang wajib diikuti setiap anggota Divisi TI kuartal ini beserta tenggatnya.',
    category: IDS.onboarding,
    owner: IDS.admin,
    labels: ['Pelatihan'],
    format: 'HTML',
    outcome: 'publish',
    reviewers: [IDS.super],
    body: `<!doctype html><html><head><title>Jadwal Pelatihan</title></head><body>
<h1>Jadwal Pelatihan Wajib Kuartal Ini</h1>
<p>DATA SINTETIS — untuk pengujian IntraDocs.</p>
<h2>Sesi</h2>
<table>
<tr><th>Pelatihan</th><th>Durasi</th><th>Tenggat</th><th>Wajib untuk</th></tr>
<tr><td>Kesadaran keamanan informasi</td><td>90 menit</td><td>Akhir bulan ke-1</td><td>Semua</td></tr>
<tr><td>Penanganan data pribadi</td><td>60 menit</td><td>Akhir bulan ke-2</td><td>Semua</td></tr>
<tr><td>Respons insiden dasar</td><td>120 menit</td><td>Akhir bulan ke-2</td><td>Infrastruktur, Keamanan</td></tr>
<tr><td>Praktik review kode</td><td>60 menit</td><td>Akhir bulan ke-3</td><td>Aplikasi Internal</td></tr>
</table>
<h2>Cara mendaftar</h2>
<ol><li>Buka portal tiket.</li><li>Pilih kategori Pelatihan.</li><li>Sebutkan sesi dan tanggal yang dipilih.</li></ol>
<p>Kehadiran dicatat oleh SDM; sesi yang terlewat dijadwalkan ulang bulan berikutnya.</p>
</body></html>`,
  },
  // ---- SOP & Proses Bisnis ----
  {
    title: 'SOP Penanganan Insiden Layanan',
    summary:
      'Langkah baku dari laporan pertama sampai penutupan insiden, dengan tingkat prioritas dan target waktu.',
    category: IDS.sop,
    owner: IDS.admin,
    labels: ['SOP', 'Insiden'],
    format: 'MD',
    outcome: 'publish',
    reviewers: [IDS.super],
    body:
      NOTE +
      `# SOP Penanganan Insiden Layanan

## Tingkat prioritas

| Prioritas | Dampak | Respons pertama | Target pemulihan |
| --- | --- | --- | --- |
| P1 | Layanan utama mati untuk semua pengguna | 15 menit | 4 jam |
| P2 | Sebagian pengguna terdampak | 30 menit | 8 jam |
| P3 | Gangguan minor, ada jalan pintas | 4 jam | 3 hari kerja |

## Alur

1. **Laporan** masuk lewat portal tiket atau pemantauan otomatis.
2. **Triase** oleh petugas jaga: tetapkan prioritas dan pemilik.
3. **Komunikasi** status setiap 30 menit untuk P1, setiap 2 jam untuk P2.
4. **Pemulihan** — utamakan mengembalikan layanan, bukan mencari akar masalah.
5. **Penutupan** setelah pengguna mengonfirmasi.
6. **Tinjauan pasca-insiden** untuk P1 dan P2 dalam 5 hari kerja.

## Yang tidak boleh dilakukan

- Mengubah konfigurasi produksi tanpa mencatatnya di tiket.
- Menutup insiden tanpa konfirmasi pelapor.
`,
  },
  {
    title: 'SOP Permintaan Perubahan (Change Request)',
    summary:
      'Cara mengajukan, menilai risiko, menjadwalkan, dan menutup perubahan pada sistem produksi.',
    category: IDS.sop,
    owner: IDS.admin,
    labels: ['SOP', 'Perubahan'],
    format: 'MD',
    outcome: 'publish',
    reviewers: [IDS.super],
    body:
      NOTE +
      `# SOP Permintaan Perubahan

## Jenis perubahan

- **Standar** — berulang, risiko rendah, sudah disetujui sebelumnya (mis. penambahan pengguna).
- **Normal** — perlu penilaian risiko dan persetujuan CAB.
- **Darurat** — untuk memulihkan layanan; persetujuan menyusul dalam 24 jam.

## Formulir

Setiap permintaan menyebutkan: tujuan, sistem terdampak, jendela waktu, rencana uji, dan
rencana pembatalan (rollback).

## Jendela perubahan

Selasa dan Kamis pukul 20.00–23.00. Di luar jendela hanya untuk perubahan darurat.

## Penutupan

Perubahan ditutup setelah verifikasi pasca-implementasi dan pembaruan dokumen terkait di portal ini.
`,
  },
  {
    title: 'Prosedur Eskalasi ke Vendor',
    summary:
      'Kapan dan bagaimana masalah diteruskan ke vendor pendukung, siapa yang berwenang, dan cara mencatatnya.',
    category: IDS.sop,
    owner: IDS.admin,
    labels: ['SOP', 'Vendor'],
    format: 'DOCX',
    outcome: 'publish',
    reviewers: [IDS.super],
    body: 'DOCX',
  },
  // ---- Keamanan Informasi ----
  {
    title: 'Kebijakan Kata Sandi & MFA',
    summary:
      'Panjang minimum, rotasi, larangan penggunaan ulang, dan kewajiban MFA untuk semua akun internal.',
    category: IDS.security,
    owner: IDS.admin,
    labels: ['Kebijakan', 'Keamanan'],
    format: 'MD',
    outcome: 'publish',
    classification: 'restricted',
    reviewers: [IDS.reviewer, IDS.super],
    body:
      NOTE +
      `# Kebijakan Kata Sandi & MFA

## Kata sandi

- Minimal **14 karakter**; frasa sandi dianjurkan.
- Tidak boleh sama dengan 5 kata sandi sebelumnya.
- Tidak ada rotasi berkala wajib; rotasi **wajib** bila ada indikasi kebocoran.
- Dilarang dibagikan, termasuk kepada rekan satu tim atau petugas dukungan.

## MFA

- Wajib untuk email, VPN, portal tiket, dan semua akses administratif.
- Metode yang diterima: aplikasi authenticator, kunci keamanan fisik. SMS tidak diterima.
- Kehilangan perangkat authenticator dilaporkan pada hari yang sama agar token dicabut.

## Akun layanan

Kata sandi akun layanan disimpan di brankas rahasia, dirotasi setiap 90 hari, dan tidak
pernah ditulis di dokumen — termasuk dokumen di portal ini.
`,
  },
  {
    title: 'Prosedur Respons Insiden Keamanan',
    summary:
      'Tahapan respons saat terjadi insiden keamanan: deteksi, penahanan, pemberantasan, pemulihan, dan pembelajaran.',
    category: IDS.security,
    owner: IDS.admin,
    classification: 'restricted',
    labels: ['Keamanan', 'Insiden'],
    format: 'MD',
    outcome: 'in_review',
    reviewers: [IDS.reviewer, IDS.super],
    body:
      NOTE +
      `# Prosedur Respons Insiden Keamanan

## Klasifikasi

Dokumen ini **Terbatas**: hanya untuk tim Keamanan Informasi dan Infrastruktur.

## Tahapan

1. **Deteksi** — dari pemantauan, laporan pengguna, atau pemberitahuan pihak ketiga.
2. **Penahanan** — isolasi sistem terdampak; jangan matikan sebelum bukti diamankan.
3. **Pemberantasan** — hapus penyebab (akun, malware, konfigurasi).
4. **Pemulihan** — kembalikan layanan dari cadangan yang diverifikasi.
5. **Pembelajaran** — laporan dalam 10 hari kerja.

## Komunikasi

Hanya juru bicara yang ditunjuk yang berkomunikasi ke luar tim. Detail teknis tidak
dibagikan di kanal umum.
`,
  },
  {
    title: 'Panduan Klasifikasi Data',
    summary:
      'Empat tingkat klasifikasi (Publik, Internal, Terbatas, Rahasia), contoh, dan cara menangani masing-masing.',
    category: IDS.security,
    owner: IDS.admin,
    labels: ['Kebijakan', 'Klasifikasi'],
    format: 'MD',
    outcome: 'publish',
    classification: 'restricted',
    reviewers: [IDS.reviewer, IDS.super],
    body:
      NOTE +
      `# Panduan Klasifikasi Data

| Tingkat | Contoh | Penyimpanan | Berbagi |
| --- | --- | --- | --- |
| Publik | Brosur layanan | Bebas | Bebas |
| Internal | SOP, panduan | Portal ini | Sesama karyawan |
| Terbatas | Prosedur respons insiden | Portal, kategori terbatas | Tim yang ditunjuk |
| Rahasia | Kunci, data pribadi | Brankas rahasia | Per orang, dicatat |

## Aturan umum

- Bila ragu, naikkan satu tingkat.
- Dokumen Terbatas dan Rahasia di portal ini hanya terbuka lewat grant per dokumen.
- Klasifikasi dicantumkan pada halaman pertama setiap dokumen.
`,
  },
  // ---- Infrastruktur & Jaringan ----
  {
    title: 'Runbook Restart Layanan Web',
    summary: 'Urutan aman untuk memulai ulang layanan web produksi tanpa memutus sesi pengguna.',
    category: IDS.infra,
    owner: IDS.contributor,
    labels: ['Runbook'],
    format: 'MD',
    outcome: 'publish',
    reviewers: [IDS.admin],
    body:
      NOTE +
      `# Runbook Restart Layanan Web

## Prasyarat

- Pengumuman di kanal operasi minimal 15 menit sebelumnya.
- Tiket perubahan bertipe Standar sudah ada.

## Langkah

1. Alihkan trafik dari node yang akan dimulai ulang di load balancer.
2. Tunggu koneksi aktif turun ke nol (maksimal 2 menit).
3. Mulai ulang layanan:

\`\`\`sh
systemctl restart web-app.service
systemctl status web-app.service
\`\`\`

4. Periksa \`/api/health\` mengembalikan \`status: ok\`.
5. Kembalikan node ke load balancer.
6. Ulangi untuk node berikutnya.

## Bila gagal

Jangan lanjut ke node berikutnya. Kembalikan node ke rotasi hanya bila health check
lulus; eskalasi sesuai SOP Penanganan Insiden.
`,
  },
  {
    title: 'Standar Penamaan Server & Alamat IP',
    summary: 'Pola nama host, segmen alamat IP per lingkungan, dan cara mencatatnya di inventaris.',
    category: IDS.infra,
    owner: IDS.contributor,
    labels: ['Standar'],
    format: 'TXT',
    outcome: 'publish',
    reviewers: [IDS.admin],
    body: `DATA SINTETIS - untuk pengujian IntraDocs.

STANDAR PENAMAAN SERVER & ALAMAT IP

Pola nama host
  <lingkungan>-<peran>-<nomor>
  lingkungan : prd | stg | dev | lab
  peran      : web | db | cache | mon | bkp
  contoh     : prd-web-01, lab-db-02

Segmen alamat (contoh laboratorium)
  lab   10.10.0.0/16
  stg   10.20.0.0/16
  prd   10.30.0.0/16

Aturan
  1. Nama host tidak memuat nama orang atau proyek.
  2. Setiap server dicatat di inventaris sebelum dinyalakan.
  3. Alamat statis hanya untuk peran db, mon, dan bkp.
`,
  },
  {
    title: 'Panduan Perencanaan Kapasitas Storage',
    summary: 'Cara memperkirakan kebutuhan penyimpanan tahunan dan ambang batas peringatan.',
    category: IDS.infra,
    owner: IDS.contributor,
    labels: ['Panduan'],
    format: 'PDF',
    outcome: 'in_review',
    reviewers: [IDS.admin],
    body: 'PDF',
  },
  // ---- Data & Integrasi ----
  {
    title: 'Katalog API Internal',
    summary: 'Daftar API internal, pemiliknya, cara autentikasi, dan batas pemakaian.',
    category: IDS.data,
    owner: IDS.contributor,
    labels: ['Referensi', 'API'],
    format: 'MD',
    outcome: 'publish',
    reviewers: [IDS.admin],
    body:
      NOTE +
      `# Katalog API Internal

| API | Pemilik | Autentikasi | Batas |
| --- | --- | --- | --- |
| Direktori pegawai | Tim SDM | Token layanan | 100 permintaan/menit |
| Tiket | Tim Aplikasi Internal | OAuth internal | 300 permintaan/menit |
| Inventaris | Tim Infrastruktur | Token layanan | 60 permintaan/menit |

## Cara meminta akses

1. Ajukan tiket dengan menyebut API, tujuan, dan perkiraan volume.
2. Pemilik API menyetujui dan menerbitkan token dengan masa berlaku 90 hari.
3. Token disimpan di brankas rahasia, tidak di repositori.

## Versi

Setiap API menyertakan \`X-API-Version\`. Versi lama tetap dilayani 6 bulan setelah versi baru rilis.
`,
  },
  {
    title: 'Prosedur Ekspor Laporan Bulanan',
    summary: 'Langkah menyiapkan dan memverifikasi ekspor laporan bulanan dari gudang data.',
    category: IDS.data,
    owner: IDS.contributor,
    labels: ['Prosedur'],
    format: 'XLSX',
    outcome: 'publish',
    reviewers: [IDS.admin],
    body: 'XLSX',
  },
  // ---- Aplikasi Internal ----
  {
    title: 'Panduan Penggunaan Portal Tiket',
    summary:
      'Cara membuat, memantau, dan menutup tiket; kategori yang tersedia dan SLA tiap kategori.',
    category: IDS.apps,
    owner: IDS.contributor,
    labels: ['Panduan'],
    format: 'MD',
    outcome: 'changes',
    reviewers: [IDS.admin],
    body:
      NOTE +
      `# Panduan Penggunaan Portal Tiket

## Membuat tiket

1. Pilih kategori (Perangkat, Akses, Aplikasi, Jaringan, Lainnya).
2. Tulis judul singkat dan langkah untuk mengulangi masalah.
3. Lampirkan tangkapan layar bila ada.

## Memantau

Status: Baru → Ditangani → Menunggu pelapor → Selesai. Tiket yang menunggu pelapor lebih
dari 5 hari kerja ditutup otomatis.

## SLA

Lihat SOP Penanganan Insiden Layanan.
`,
  },
  {
    title: 'FAQ Aplikasi Absensi',
    summary: 'Jawaban atas pertanyaan yang sering diajukan tentang aplikasi absensi.',
    category: IDS.apps,
    owner: IDS.contributor,
    labels: ['FAQ'],
    format: 'MD',
    outcome: 'draft',
    body:
      NOTE +
      `# FAQ Aplikasi Absensi

**Saya lupa absen masuk.** Ajukan koreksi lewat menu Koreksi sebelum pukul 17.00 hari yang sama.

**Aplikasi tidak mendeteksi lokasi.** Pastikan izin lokasi diberikan dan GPS aktif.

**Bekerja dari rumah.** Pilih mode Jarak Jauh; lokasi tidak diperiksa pada mode ini.

_(Draf — masih menunggu jawaban dari tim SDM untuk dua pertanyaan lagi.)_
`,
  },
  {
    title: 'Panduan Rilis Aplikasi Mobile',
    summary: 'Langkah rilis versi baru aplikasi mobile internal ke toko aplikasi perusahaan.',
    category: IDS.apps,
    owner: IDS.contributor,
    labels: ['Panduan', 'Rilis'],
    format: 'MD',
    outcome: 'reject',
    reviewers: [IDS.admin],
    body:
      NOTE +
      `# Panduan Rilis Aplikasi Mobile

1. Naikkan nomor versi.
2. Bangun paket rilis.
3. Unggah ke toko aplikasi perusahaan.
4. Beri tahu pengguna.

_(Versi ini terlalu ringkas — belum ada langkah uji dan rencana pembatalan.)_
`,
  },
];

const DECISION_NOTES = {
  changes:
    'Bagian SLA hanya merujuk ke SOP lain; tambahkan tabel ringkas SLA per kategori tiket dan tangkapan layar formulir agar panduan berdiri sendiri.',
  reject:
    'Tidak ada langkah pengujian sebelum unggah dan tidak ada rencana pembatalan. Rilis mobile tanpa keduanya tidak boleh dijadikan prosedur. Ajukan ulang setelah dilengkapi.',
};

async function upload(doc: Doc): Promise<{ documentId: string; versionId: string; slug: string }> {
  const form = new FormData();
  let bytes: Uint8Array;
  let name: string;
  let mime: string;
  if (doc.format in FIXTURES) {
    const f = FIXTURES[doc.format]!;
    bytes = new Uint8Array(await readFile(path.join(ROOT, 'fixtures/uploads', f.file)));
    name = f.file;
    mime = f.mime;
  } else {
    bytes = new TextEncoder().encode(doc.body);
    const ext = { MD: 'md', TXT: 'txt', HTML: 'html' }[doc.format as 'MD' | 'TXT' | 'HTML'];
    name = `${doc.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .slice(0, 40)}.${ext}`;
    mime = { MD: 'text/markdown', TXT: 'text/plain', HTML: 'text/html' }[
      doc.format as 'MD' | 'TXT' | 'HTML'
    ];
  }
  form.set('file', new File([Buffer.from(bytes)], name, { type: mime }));
  for (const [k, v] of Object.entries({
    title: doc.title,
    summary: doc.summary,
    categoryId: doc.category,
    classification: doc.classification ?? 'internal',
    labels: JSON.stringify(doc.labels),
    synthetic: 'true',
  }))
    form.set(k, v);
  const r = await fetch(`${base}/api/documents/drafts`, {
    method: 'POST',
    headers: { Cookie: await login(doc.owner), Origin: base, 'Idempotency-Key': randomUUID() },
    body: form,
  });
  const body = (await r.json()) as {
    documentId: string;
    versionId: string;
    slug: string;
    error?: string;
  };
  if (r.status !== 201)
    throw new Error(`upload "${doc.title}": HTTP ${r.status} ${body.error ?? ''}`);
  return body;
}

async function waitPublished(versionId: string): Promise<void> {
  for (let i = 0; i < 240; i++) {
    const r = await db.query('SELECT publication_state FROM app.document_versions WHERE id=$1', [
      versionId,
    ]);
    if (r.rows[0]?.publication_state === 'published') return;
    await new Promise((d) => setTimeout(d, 500));
  }
  throw new Error(`versi ${versionId} tidak terbit dalam batas waktu`);
}

async function main(): Promise<void> {
  const existing = new Set(
    (await db.query<{ title: string }>('SELECT title FROM app.document_versions')).rows.map(
      (r) => r.title,
    ),
  );
  const created: Array<Doc & { documentId: string; versionId: string; slug: string }> = [];
  for (const doc of DOCS) {
    if (existing.has(doc.title)) {
      console.log(`  lewati (sudah ada)  ${doc.title}`);
      continue;
    }
    const u = await upload(doc);
    created.push({ ...doc, ...u });
    console.log(`  unggah ${doc.format.padEnd(4)} ${doc.title}`);
    if (doc.outcome === 'draft') continue;
    // A restricted document is readable only by grant, reviewers included: the owner
    // grants each reviewer before submitting, exactly as the reader's access panel does.
    if (doc.classification === 'restricted')
      for (const member of doc.reviewers ?? [])
        await api(doc.owner, `/api/documents/${u.documentId}/access`, { member, grant: true });
    const submit = await api(doc.owner, `/api/versions/${u.versionId}/submit`, {
      reviewers: doc.reviewers,
      confirmed: true,
    });
    if (submit.status !== 200)
      throw new Error(`submit "${doc.title}": ${JSON.stringify(submit.body)}`);
    if (doc.outcome === 'in_review') continue;
    const first = doc.reviewers![0]!;
    const decision =
      doc.outcome === 'changes'
        ? 'changes_requested'
        : doc.outcome === 'reject'
          ? 'reject'
          : 'approve';
    const d = await api(first, `/api/versions/${u.versionId}/decision`, {
      decision,
      reason: decision === 'approve' ? '' : DECISION_NOTES[doc.outcome as 'changes' | 'reject'],
    });
    if (d.status !== 200) throw new Error(`decision "${doc.title}": ${JSON.stringify(d.body)}`);
    // A two-stage document (restricted/confidential) needs the second reviewer too.
    if (decision === 'approve')
      for (const next of doc.reviewers!.slice(1)) {
        const d2 = await api(next, `/api/versions/${u.versionId}/decision`, {
          decision: 'approve',
          reason: '',
        });
        if (d2.status !== 200)
          throw new Error(`decision 2 "${doc.title}": ${JSON.stringify(d2.body)}`);
      }
  }
  // Publication runs in the worker; wait for all of them at once.
  const publishing = created.filter((c) => c.outcome === 'publish');
  if (publishing.length) {
    process.stdout.write(`  menunggu ${publishing.length} publikasi + indeks…`);
    for (const c of publishing) await waitPublished(c.versionId);
    console.log(' selesai');
  }

  const byTitle = async (title: string) =>
    (
      await db.query<{ id: string; version_id: string; category_id: string; slug: string }>(
        'SELECT d.id, d.current_version_id AS version_id, d.category_id, d.slug FROM app.documents d JOIN app.document_versions v ON v.id=d.current_version_id WHERE v.title=$1',
        [title],
      )
    ).rows[0];

  // ---- Readers: feedback, favourites, read history ----
  const feedback: Array<[string, string, boolean, string]> = [
    [IDS.viewer, 'Konfigurasi VPN untuk Windows, macOS & Mobile', true, ''],
    [
      IDS.viewer,
      'Runbook Restart Layanan Web',
      true,
      'Urutan langkahnya jelas; berhasil saya ikuti saat pemeliharaan malam.',
    ],
    [
      IDS.viewer,
      'Katalog API Internal',
      false,
      'Batas pemakaian API Inventaris di tabel berbeda dengan yang saya alami (dibatasi di 30/menit). Mohon dicek.',
    ],
    [IDS.other, 'SOP Penanganan Insiden Layanan', true, ''],
    [
      IDS.other,
      'SOP Permintaan Perubahan (Change Request)',
      false,
      'Belum ada contoh formulir yang sudah terisi; sulit membayangkan seberapa detail rencana pembatalannya.',
    ],
    [IDS.reviewer, 'Kebijakan Kata Sandi & MFA', true, 'Bagian akun layanan sangat membantu.'],
  ];
  for (const [actor, title, helpful, comment] of feedback) {
    const doc = await byTitle(title);
    if (!doc) continue;
    // A read is what an owner sees in "Paling dibaca" and what fills a viewer's history.
    await fetch(`${base}/dokumen/${doc.id}/${doc.slug}`, {
      headers: { Cookie: await login(actor) },
    });
    const r = await api(actor, '/api/feedback', { versionId: doc.version_id, helpful, comment });
    if (r.status !== 200 && r.status !== 404) console.log(`  masukan ${title}: ${r.status}`);
  }
  for (const title of [
    'Konfigurasi VPN untuk Windows, macOS & Mobile',
    'Runbook Restart Layanan Web',
    'Panduan Reset Password Akun Lab',
  ]) {
    const doc = await byTitle(title);
    if (doc) await api(IDS.viewer, `/api/documents/${doc.id}/favorite`, { favorite: true });
  }
  // More reads so "Paling dibaca" and the dashboard have a curve, not a single bar.
  for (const [actor, titles] of [
    [
      IDS.other,
      [
        'SOP Penanganan Insiden Layanan',
        'SOP Permintaan Perubahan (Change Request)',
        'Prosedur Eskalasi ke Vendor',
      ],
    ],
    [
      IDS.contributor,
      [
        'Panduan Hari Pertama Karyawan Baru TI',
        'Standar Penamaan Server & Alamat IP',
        'Katalog API Internal',
      ],
    ],
    [IDS.reviewer, ['Panduan Klasifikasi Data', 'Kebijakan Kata Sandi & MFA']],
    [
      IDS.viewer,
      [
        'Checklist Perangkat Kerja & Akun',
        'Jadwal Pelatihan Wajib Kuartal Ini',
        'Standar Penamaan Server & Alamat IP',
      ],
    ],
  ] as const) {
    for (const title of titles) {
      const doc = await byTitle(title);
      if (doc)
        await fetch(`${base}/dokumen/${doc.id}/${doc.slug}`, {
          headers: { Cookie: await login(actor) },
        });
    }
  }
  console.log('  masukan pembaca, favorit, riwayat baca');

  // ---- Access requests: two pending for the admin, one already decided ----
  const pendingReq = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM app.access_requests WHERE state='pending'",
  );
  if (pendingReq.rows[0]!.n === 0) {
    // A request asks for a higher classification inside a category the person already
    // has; a category outside their scope is refused by RLS, as it should be.
    const r1 = await api(IDS.viewer, '/api/access-requests', {
      categoryId: IDS.infra,
      classification: 'restricted',
      reason:
        'Saya membantu tim Infrastruktur menyusun runbook pemulihan dan perlu membaca dokumen konfigurasi jaringan berklasifikasi Terbatas sebagai rujukan.',
    });
    const r2 = await api(IDS.other, '/api/access-requests', {
      categoryId: IDS.sop,
      classification: 'restricted',
      reason:
        'Untuk audit internal kuartal ini saya perlu memeriksa prosedur eskalasi yang berklasifikasi Terbatas pada kategori SOP & Proses Bisnis.',
    });
    for (const r of [r1, r2])
      if (r.status !== 200)
        console.log(`  permintaan akses: ${r.status} ${JSON.stringify(r.body)}`);
    const decided = await api(IDS.contributor, '/api/access-requests', {
      categoryId: IDS.data,
      classification: 'restricted',
      reason:
        'Menyiapkan integrasi log ke gudang data; perlu membaca skema integrasi berklasifikasi Terbatas untuk menyelaraskan format ekspor.',
    });
    const id = (decided.body as { id?: string }).id;
    if (id)
      await api(IDS.admin, `/api/access-requests/${id}`, {
        approve: true,
        note: 'Disetujui untuk keperluan integrasi pemantauan; grant per dokumen menyusul dari pemilik.',
      });
    console.log('  permintaan akses: 2 menunggu, 1 diputuskan');
  }

  // ---- Required reading with a due date (for the "Bacaan wajib" block on the home) ----
  // Each requirement points at a document its audience can open: a category's readers
  // cannot acknowledge a restricted document from another category.
  const pw = await byTitle('Standar Penamaan Server & Alamat IP');
  const sop = await byTitle('SOP Penanganan Insiden Layanan');
  const apiDoc = await byTitle('Katalog API Internal');
  const hari1 = await byTitle('Panduan Hari Pertama Karyawan Baru TI');
  const have = await db.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM app.reading_requirements',
  );
  if (have.rows[0]!.n === 0) {
    const due = new Date(Date.now() + 14 * 86400000).toISOString();
    if (pw)
      for (const cat of [IDS.infra, IDS.apps])
        await api(IDS.admin, '/api/required-reading', {
          documentId: pw.id,
          categoryId: cat,
          note: 'Wajib dibaca sebelum inventaris server diperbarui akhir bulan ini.',
          dueAt: due,
        });
    if (apiDoc)
      await api(IDS.admin, '/api/required-reading', {
        documentId: apiDoc.id,
        categoryId: IDS.data,
        note: 'Wajib dibaca sebelum meminta token API baru; batas pemakaian berubah kuartal ini.',
        dueAt: due,
      });
    if (sop)
      await api(IDS.admin, '/api/required-reading', {
        documentId: sop.id,
        categoryId: IDS.sop,
        note: 'Wajib dibaca semua petugas jaga sebelum rotasi jaga bulan depan.',
        dueAt: due,
      });
    if (hari1)
      await api(IDS.admin, '/api/required-reading', {
        documentId: hari1.id,
        categoryId: IDS.onboarding,
        note: 'Bacaan wajib setiap karyawan baru pada minggu pertama.',
        dueAt: null,
      });
    console.log('  bacaan wajib ditetapkan');
  }

  // ---- A couple of assistant conversations (real model calls; skipped if AI is off) ----
  if (process.env.AI_PROVIDER === 'weknora-local' && !process.argv.includes('--no-ai')) {
    for (const [actor, questions] of [
      [
        IDS.viewer,
        [
          'Apa prioritas P1 dan berapa target pemulihannya?',
          'Siapa yang boleh berkomunikasi ke luar saat insiden?',
        ],
      ],
      [IDS.other, ['Kapan jendela perubahan yang diizinkan?']],
    ] as const) {
      let conversationId: string | undefined;
      for (const q of questions) {
        const r = await api(actor, '/api/rag/chat', {
          question: q,
          ...(conversationId ? { conversationId } : {}),
        });
        conversationId = (r.body as { conversationId?: string }).conversationId;
      }
    }
    console.log('  percakapan asisten');
  }
  await db.query('DELETE FROM auth."rateLimit"');
  await db.end();
  console.log('Selesai.');
}

main().catch(reportFailure);
