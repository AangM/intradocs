// Deliberately synthetic, non-production fixture identities. IDs are stable for repeatable tests.
export const IDS = {
  super: '00000000-0000-4000-8000-000000000001',
  admin: '00000000-0000-4000-8000-000000000002',
  contributor: '00000000-0000-4000-8000-000000000003',
  reviewer: '00000000-0000-4000-8000-000000000004',
  viewer: '00000000-0000-4000-8000-000000000005',
  other: '00000000-0000-4000-8000-000000000006',
  disabled: '00000000-0000-4000-8000-000000000007',
  infra: '10000000-0000-4000-8000-000000000001',
  security: '10000000-0000-4000-8000-000000000002',
  apps: '10000000-0000-4000-8000-000000000003',
  sop: '10000000-0000-4000-8000-000000000004',
  onboarding: '10000000-0000-4000-8000-000000000005',
  data: '10000000-0000-4000-8000-000000000006',
} as const;
export const docId = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const versionId = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const users = [
  {
    id: IDS.super,
    name: 'Budi Hartono',
    email: 'budi@example.test',
    role: 'super_admin',
    unit: 'Infrastructure',
    scopeAll: true,
    active: true,
    categories: [],
  },
  {
    id: IDS.admin,
    name: 'Andi Wijaya',
    email: 'andi@example.test',
    role: 'knowledge_admin',
    unit: 'IT Governance',
    scopeAll: true,
    active: true,
    categories: [],
  },
  {
    id: IDS.contributor,
    name: 'Rizky Ananda',
    email: 'rizky@example.test',
    role: 'contributor',
    unit: 'IT Operations',
    scopeAll: false,
    active: true,
    categories: [IDS.infra, IDS.data, IDS.apps],
  },
  {
    id: IDS.reviewer,
    name: 'Dwi Kurniawan',
    email: 'dwi@example.test',
    role: 'reviewer',
    unit: 'Information Security',
    scopeAll: false,
    active: true,
    categories: [IDS.security],
  },
  {
    id: IDS.viewer,
    name: 'Siti Rahmawati',
    email: 'siti@example.test',
    role: 'viewer',
    unit: 'IT Operations',
    scopeAll: false,
    active: true,
    categories: [IDS.infra, IDS.data],
  },
  {
    id: IDS.other,
    name: 'Fajar Nugroho',
    email: 'fajar@example.test',
    role: 'viewer',
    unit: 'Finance',
    scopeAll: false,
    active: true,
    categories: [IDS.sop],
  },
  {
    id: IDS.disabled,
    name: 'Pengguna Nonaktif',
    email: 'nonaktif@example.test',
    role: 'viewer',
    unit: 'IT Operations',
    scopeAll: false,
    active: false,
    categories: [IDS.infra],
  },
] as const;
export const categories = [
  {
    id: IDS.infra,
    name: 'Infrastruktur & Jaringan',
    description: 'Konfigurasi server, VPN, firewall, topologi jaringan, dan data center.',
    icon: 'server',
    color: 'blue',
  },
  {
    id: IDS.security,
    name: 'Keamanan Informasi',
    description: 'Kebijakan ISMS, penanganan insiden, hardening, dan audit keamanan.',
    icon: 'shield',
    color: 'red',
  },
  {
    id: IDS.apps,
    name: 'Aplikasi Internal',
    description: 'Panduan aplikasi, repositori, dan layanan internal tim.',
    icon: 'layers',
    color: 'green',
  },
  {
    id: IDS.sop,
    name: 'SOP & Proses Bisnis',
    description: 'Standar operasional, alur persetujuan, dan tanggung jawab.',
    icon: 'flow',
    color: 'violet',
  },
  {
    id: IDS.onboarding,
    name: 'Onboarding & SDM',
    description: 'Panduan karyawan baru, akses awal, perangkat kerja, dan pelatihan.',
    icon: 'users',
    color: 'amber',
  },
  {
    id: IDS.data,
    name: 'Data & Integrasi',
    description: 'Skema database, API internal, dan tata kelola data.',
    icon: 'db',
    color: 'sky',
  },
] as const;
const note =
  '> DATA SINTETIS — untuk pengujian IntraDocs. Bukan kebijakan resmi atau instruksi operasional Telkom.\n\n';
export const documents = [
  {
    n: 1,
    title: 'Konfigurasi VPN untuk Windows, macOS & Mobile',
    slug: 'konfigurasi-vpn',
    summary: 'Panduan contoh menyiapkan koneksi VPN dan memeriksa konektivitas perangkat kerja.',
    category: IDS.infra,
    owner: IDS.contributor,
    classification: 'internal',
    labels: ['Runbook', 'Jaringan'],
    version: '1.0',
    state: 'approved',
    markdown:
      note +
      '## Sebelum memulai\n\nPastikan perangkat uji memakai sistem operasi yang didukung. Minta akun uji melalui administrator laboratorium.\n\n## Langkah konfigurasi\n\n1. Buka aplikasi VPN pada perangkat uji.\n2. Pilih profil laboratorium yang diberikan administrator.\n3. Masuk menggunakan akun uji dan MFA.\n4. Periksa indikator koneksi dan akses halaman uji.\n\n### Verifikasi\n\nGunakan hostname dokumentasi, bukan alamat server produksi.\n\n```sh\nping vpn.example.test\n```\n\n## Jika koneksi gagal\n\nCatat kode kesalahan tanpa menyalin password, token, atau data pribadi. Kirim ke pemilik dokumen untuk ditinjau.',
  },
  {
    n: 2,
    title: 'Panduan Instalasi Agent Monitoring Server',
    slug: 'agent-monitoring',
    summary:
      'Prasyarat, proses pemasangan, dan verifikasi agent monitoring di lingkungan simulasi.',
    category: IDS.infra,
    owner: IDS.contributor,
    classification: 'internal',
    labels: ['Runbook', 'Monitoring'],
    version: '1.0',
    state: 'approved',
    markdown:
      note +
      '## Tujuan\n\nMendokumentasikan pemasangan agent pada server laboratorium.\n\n## Prasyarat\n\n- Akses server uji yang telah disetujui.\n- Paket agent yang diverifikasi checksum-nya.\n- Identitas layanan dari secret manager, tidak ditulis dalam dokumen.\n\n## Verifikasi\n\nPastikan metrik perangkat uji muncul. Jangan menonaktifkan kontrol keamanan untuk mengatasi kegagalan instalasi.',
  },
  {
    n: 3,
    title: 'Kebijakan Backup & Retensi Data — Contoh',
    slug: 'backup-retensi-contoh',
    summary: 'Contoh struktur kebijakan backup, verifikasi pemulihan, dan kepemilikan data.',
    category: IDS.data,
    owner: IDS.contributor,
    classification: 'internal',
    labels: ['Referensi', 'Tata Kelola'],
    version: '3.2',
    state: 'approved',
    markdown:
      note +
      '## Ruang lingkup\n\nHanya berlaku untuk dataset sintetis laboratorium.\n\n## Verifikasi backup\n\nBackup belum dianggap berhasil sebelum hasil restore dapat diverifikasi.\n\n| Pemeriksaan | Bukti |\n| --- | --- |\n| Integritas | Checksum artefak sama |\n| Metadata | Versi dan pemilik terjaga |\n| Akses | Dokumen yang dicabut tetap tidak terlihat |\n\n## Retensi\n\nRetensi produksi harus disetujui pemilik data. Nilai pada lingkungan development tidak boleh dianggap kebijakan perusahaan.',
  },
  {
    n: 4,
    title: 'Standar Penamaan Repository & Branch Strategy',
    slug: 'standar-repository',
    summary: 'Contoh konvensi repository, branch, dan review perubahan untuk dua developer.',
    category: IDS.apps,
    owner: IDS.contributor,
    classification: 'internal',
    labels: ['Standar'],
    version: '1.3',
    state: 'approved',
    markdown:
      note +
      '## Repository\n\nGunakan nama singkat yang menjelaskan produk.\n\n## Branch\n\n- `main` untuk perubahan yang sudah direview.\n- `feat/nama-fitur` untuk satu irisan fitur.\n- `fix/nama-masalah` untuk perbaikan terarah.\n\n## Review\n\nCantumkan requirement, cara menjalankan tes, dan risiko. Jangan menyimpan `.env.local` atau credential dalam Git.',
  },
  {
    n: 5,
    title: 'Matriks SLA Layanan IT — Dataset Contoh',
    slug: 'matriks-sla-contoh',
    summary:
      'Tabel Markdown sintetis untuk menguji pembacaan dokumen. Bukan target SLA organisasi.',
    category: IDS.sop,
    owner: IDS.admin,
    classification: 'public',
    labels: ['Referensi'],
    version: '1.0',
    state: 'approved',
    markdown:
      note +
      '## Matriks layanan\n\n| Layanan uji | Target contoh | Pemilik |\n| --- | --- | --- |\n| Permintaan akses lab | 1 hari kerja | Admin lab |\n| Pemulihan data sintetis | 4 jam | Operator lab |\n\n## Batas penggunaan\n\nAngka di atas hanya fixture. Konfirmasi SLA nyata kepada pemilik layanan.',
  },
  {
    n: 6,
    title: 'SOP-IT-014 — Manajemen Identitas (Contoh Terbatas)',
    slug: 'manajemen-identitas',
    summary:
      'Fixture terbatas untuk membuktikan judul, isi, dan download tidak bocor di luar izin.',
    category: IDS.security,
    owner: IDS.reviewer,
    classification: 'restricted',
    labels: ['Identity', 'SOP'],
    version: '3.1',
    state: 'approved',
    markdown:
      note +
      '## 2.1 Reset Password\n\nProsedur ini adalah contoh struktur dokumen, bukan panduan melakukan reset pada sistem nyata.\n\n### 2.1.1 Jalur Self-Service\n\nGunakan layanan identitas laboratorium. Jangan masukkan data pribadi ke aplikasi demo.\n\n### 2.1.2 Jalur Service Desk\n\nVerifikasi identitas mengikuti kebijakan pemilik layanan yang telah disahkan.\n\n### 2.1.3 Reset Darurat\n\nPermintaan harus melalui persetujuan berwenang. Chatbot tidak memiliki kemampuan melakukan reset.',
  },
  {
    n: 7,
    title: 'Lampiran Simulasi Keamanan — Rahasia',
    slug: 'lampiran-keamanan',
    summary:
      'Dokumen sintetis untuk menguji grant eksplisit, termasuk penolakan terhadap super admin tanpa grant.',
    category: IDS.security,
    owner: IDS.reviewer,
    classification: 'confidential',
    labels: ['Kritikal'],
    version: '1.0',
    state: 'approved',
    markdown:
      note +
      '## Tujuan uji\n\nKonten uji ini hanya terlihat oleh akun yang mendapat grant eksplisit.\n\n## Canary pengujian\n\n`SYNTHETIC-CONFIDENTIAL-CANARY-7`\n\nString di atas bukan secret asli; dipakai untuk mendeteksi kebocoran pada tes HTTP dan retrieval.',
  },
  {
    n: 8,
    title: 'Prosedur Migrasi Database Core — Draft Contoh',
    slug: 'draft-migrasi',
    summary: 'Draft pribadi yang tidak boleh dibaca viewer maupun muncul pada katalog published.',
    category: IDS.data,
    owner: IDS.contributor,
    classification: 'internal',
    labels: ['Kritikal', 'Runbook'],
    version: '0.9',
    state: 'in_review',
    markdown:
      note +
      '## Tujuan\n\nMenguji isolasi draft dan pengajuan review.\n\n## Rencana\n\nKonten belum tervalidasi; tidak boleh menjadi sumber AI.\n\n`SYNTHETIC-DRAFT-CANARY-8`',
  },
  {
    n: 9,
    title: 'Runbook Lama yang Dicabut',
    slug: 'runbook-dicabut',
    summary: 'Fixture pencabutan publikasi. Hanya pemilik yang tetap dapat membacanya.',
    category: IDS.infra,
    owner: IDS.contributor,
    classification: 'internal',
    labels: ['Runbook'],
    version: '1.0',
    state: 'approved',
    withdrawn: true,
    markdown: note + '## Ditarik dari publikasi\n\n`SYNTHETIC-WITHDRAWN-CANARY-9`',
  },
  {
    n: 10,
    title: 'Kebijakan Retensi Lama — Kedaluwarsa',
    slug: 'retensi-lama',
    summary: 'Versi kedaluwarsa untuk menguji pengecualian dari pencarian default.',
    category: IDS.data,
    owner: IDS.contributor,
    classification: 'internal',
    labels: ['Referensi'],
    version: '0.5',
    state: 'approved',
    expired: true,
    markdown:
      note +
      '## Tidak berlaku\n\nDokumen ini hanya fixture histori. Jangan digunakan sebagai rujukan operasional.',
  },
] as const;
