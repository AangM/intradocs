# UI — kontrak kesetiaan terhadap mockup

**Acuan utama:** [HTML mentor](../reference/intradocs-mockup_1.html). Bukan tema generik GitDoc/shadcn. Perubahan di bawah adalah usulan D02, belum persetujuan pengguna. Dokumen ini merupakan audit sumber, **bukan hasil render atau bukti pixel parity**.

Integritas referensi: 177.825 byte; SHA-256 `f4aacfbc90a30a5e7b83370704de887b7804571d99b65614bee5104bf5745621`. File asli dipertahankan byte-for-byte.

## 1. Peta layar dan komponen

| Bagian / lokasi sumber   | Route usulan               | Komponen khas yang dipertahankan                                                                                      |
| ------------------------ | -------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| S01 · `#s1`, baris 466   | `/help-center`             | Topnav, hero/grid halus, search besar, chips, statistik, kategori tiga kolom, most-read, banner AI, publikasi, footer |
| S02 · `#s2`, baris 622   | `/search`                  | Filter kiri 228 px; hasil dengan breadcrumb, highlight, metadata, kartu jawaban AI dan sitasi                         |
| S03 · `#s3`, baris 737   | `/katalog`                 | Sidebar, toolbar filter, format file berwarna, tabel delapan kolom termasuk aksi, paginasi                            |
| S04 · `#s4`, baris 852   | `/dokumen/[id]/[slug]`     | Navigasi dokumen 250 px, isi, TOC 212 px; approval, callout, kode, feedback, versi                                    |
| S05 · `#s5`, baris 981   | `/unggah`                  | Area 920 px, stepper empat langkah, dropzone, file progress, bantuan metadata, form, footer aksi                      |
| S06 · `#s6`, baris 1114  | `/admin/approval`          | Sidebar + antrean 352 px + detail; panel timeline/catatan 310 px ketika ruang cukup                                   |
| S07 · `#s7`, baris 1294  | `/admin/kategori-label`    | Tree kategori, label berwarna, saran perapian, aturan otomatis                                                        |
| S08 · `#s8`, baris 1423  | `/admin/pengguna`          | Lima kartu role + kartu tambah, matriks centang/peringatan/tolak, tabel pengguna                                      |
| S09 · `#s9`, baris 1592  | `/ai-assistant`            | Sidebar histori/scope; pesan 730 px; kartu sumber; composer tetap dan saran                                           |
| S10 · `#s10`, baris 1709 | `/admin/dashboard`         | Empat KPI, aktivitas dua seri, donut status, topik, gap, kontributor                                                  |
| S11 · `#s11`, baris 1852 | Tidak perlu route produksi | Arsitektur, proses, roadmap, manfaat, keamanan dicakup dokumen rencana                                                |

ID stabil untuk akses dan sitasi; slug kosmetik. URL bergaya kategori mentor boleh redirect ke ID yang sama sesudah pemeriksaan izin. Tidak ada URL berkas yang sekaligus merupakan izin akses.

## 2. Token dan ukuran yang disalin, bukan ditebak

```css
--blue-50: #eff6ff;
--blue-100: #dbeafe;
--blue-200: #bfdbfe;
--blue-500: #3b82f6;
--blue-600: #2563eb;
--blue-700: #1d4ed8;
--blue-900: #1e3a8a;
--ink: #0f172a;
--ink-2: #1e293b;
--muted: #64748b;
--muted-2: #94a3b8;
--line: #e2e8f0;
--line-2: #f1f5f9;
--bg: #f8fafc;
--green: #059669;
--amber: #b45309;
--red: #dc2626;
--violet: #7c3aed;
--r: 10px;
--r-lg: 14px;
```

- Topbar 56 px; sidebar umum 240 px; padding konten 26×32 px.
- Help center: hero padding 52/32/40 px, heading 38 px, search maksimum 640 px; section maksimum 1120 px.
- Reader: wrapper maksimum 760 px, padding 34/44/60 px, judul 31 px; paragraf 14,2 px/1,78. Chat maksimum 730 px.
- Sistem font asli: Inter, Apple system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif. HTML tidak memuat font Inter; font lingkungan memengaruhi hasil. Tetapkan font yang sama pada baseline dan aplikasi; self-host jika memakai Inter, tanpa CDN.
- Copy SVG sprite `ic-*`, radius, shadow, gradient, spacing, dan hierarchy dari sumber. Radix hanya untuk perilaku dialog/menu; jangan membawa visual default UI kit.

Bukan seluruh HTML dipindahkan sebagai satu komponen. Ekstrak komponen nyata: AppShell, AdminShell, SearchBox, Badge, FileType, DocumentTable, DocumentReader, UploadStepper, ApprovalDetail, CitationList. Abstraksi baru hanya jika benar-benar dipakai ulang.

## 3. Perubahan terkendali yang perlu diterima

| Delta | Perubahan dan alasannya                                                                                                                                                                                                          |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U01   | Hilangkan bingkai browser palsu, tombol layar 01–11, dan catatan presentasi pada aplikasi produksi. Bandingkan area aplikasi, bukan deck.                                                                                        |
| U02   | Ganti tinggi demo tetap 840 px dengan layout viewport/scroll yang benar. Mockup hanya menyembunyikan TOC pada ≤1200 px; responsivitas lengkap belum ada.                                                                         |
| U03   | Sembunyikan hasil tanpa izin (D01). Status workflow, sensitivitas, freshness, dan status indeks tidak dicampur.                                                                                                                  |
| U04   | Pada approval tahap awal: “Setujui tahap ini”. Hanya approver terakhir melihat “Setujui & proses publikasi”. Tampilkan indexing/failed/ready secara jujur.                                                                       |
| U05   | Angka demo diganti data nyata atau “Belum ada data”. Jangan menampilkan “96% akurasi AI”, “0,18 detik”, “2,4 detik”, dan persentase kemiripan tanpa pengukuran yang benar.                                                       |
| U06   | Search, checkbox, select, tombol, dan composer menjadi elemen semantik yang berfungsi; fokus keyboard, label, dan kontras AA diperbaiki. Target sentuh minimal 44 px dengan hit-area, sebisa mungkin tanpa mengubah ikon visual. |
| U07   | Ringkasan AI pada search dibuat atas aksi pengguna, bukan setiap ketikan. Chat pilot mengirim status proses lalu jawaban tervalidasi; efek streaming token mentah bukan prioritas.                                               |
| U08   | Fitur/format V1 tidak berpura-pura aktif di pilot. Pesan yang jelas lebih baik daripada tombol mati atau sukses palsu.                                                                                                           |

Warna Telkom baru, dark mode, animasi tambahan, layout kartu generik, atau penyederhanaan yang menghapus metadata **bukan perubahan otomatis yang diizinkan**.

## 4. Responsive dan state wajib

Desktop lebar mengikuti mentor. Pada 1024 px, TOC jadi drawer dan antrean/detail approval menjadi tampilan master–detail agar kolom tidak terjepit. Pada sekitar 390 px, sidebar/filter menjadi drawer, grid menjadi satu kolom, metadata membungkus, stepper ringkas, composer tetap terlihat. Tabel/kode boleh scroll di wilayahnya; halaman tidak boleh overflow horizontal. TOC dan aksi penting tetap bisa diakses.

Login adalah layar pendukung baru dengan token mentor: form credentials pada local-dev, tombol SSO pada mode organisasi; tanpa social-login dekoratif atau role-picker bypass. AI tanpa key menampilkan belum aktif, bukan jawaban contoh yang menyamar sebagai inference nyata. Semua alur menguji loading, kosong, error/retry, izin dicabut, dan tidak ditemukan. Tambahan: upload sebagian gagal/cancel/file ditolak; OCR berkualitas rendah; reviewer conflict/revisi; indexing gagal; AI timeout/tidak cukup bukti/konflik/quota. Form tidak kehilangan input saat gagal; dialog mendukung Escape dan focus return; `⌘/Ctrl+K` pencarian tanpa mengganggu pengetikan. Jangan membawa shortcut panah navigasi deck ke reader/editor.

## 5. Pembuktian visual, nanti saat implementasi

1. Bekukan HTML asli; gunakan fixtures dan waktu demo tetap. Lingkungan browser, font, zoom, dan DPR yang sama; baseline dari area `.app` setiap `#s1`–`#s10`.
2. Pada viewport desktop 1480 px, ukur bounding box area aplikasi referensi; samakan ukuran area aplikasi implementasi, jangan membandingkan viewport deck dengan aplikasi fullscreen secara langsung. Uji pula 1024 dan 390 px; layout mobile dinilai terhadap delta yang disetujui, karena tidak ada desain mobile lengkap dari mentor.
3. Ambil snapshot tiap layar, bagian bawah inner-scroll, tab/dialog penting dan state gagal; periksa satu per satu. Delta U01–U08 dicatat, bukan disembunyikan dengan mask seluruh area.
4. Target awal diff ≤1% pada area stabil setelah normalisasi; selalu review side-by-side. Threshold bukan izin mengabaikan pergeseran layout, teks salah, clipping, atau aksesibilitas.
5. Simpan snapshot/bukti di PR implementasi. **Saat paket rencana ini dibuat, render dan pemeriksaan visual tersebut belum dijalankan.**

**Dijalankan (September 2026).** `pnpm ui:shots` (`scripts/ui-shots.ts`, Playwright Chromium headless) memotret area `.app` setiap `#s1`–`#s10` mockup dan semua halaman portal sebagai satu akun sintetis pada viewport yang sama (1440 px; `SHOT_W=390` untuk pass mobile) ke `var/shots/`. Dari perbandingan berdampingan itu, layar yang tadinya jauh dari mockup dibawa kembali: S06 approval menjadi master–detail dengan keputusan, temuan pra-cek, pratinjau dan timeline; S02 facet berjumlah dan highlight; S03 chip filter dan tabel berlabel; S04 kaki halaman ringkas; S07 tree berhitung dan form di balik tombol; S09 avatar, kartu sumber bernomor dan composer menempel; S10 chart CSS dari angka nyata. Yang sengaja tetap berbeda (delta U01–U08) tidak berubah: tidak ada angka demo, tidak ada toggle yang tidak berfungsi (aturan ditampilkan sebagai baris centang, bukan switch), dan konten di luar izin tidak pernah dirender. Belum ada diff piksel otomatis; buktinya adalah screenshot yang dibandingkan orang.

## Delta M2a (source, belum visual acceptance)

S05 tetap area 920 px, stepper empat langkah, dropzone, kartu metadata dan footer mentor. Tahap terakhir menjadi “Simpan Draft Privat”, bukan approval palsu. Format yang tersedia hanya MD/TXT ≤1 MiB; angka 50 MB dan format V1 tidak ditampilkan sebagai dukungan aktif. Metadata diisi manual, pemilik dari session, klasifikasi Internal. Pratinjau adalah teks lokal literal (dipotong eksplisit pada 20.000 karakter), bukan status scan. Proses simpan memakai pesan indeterminate, bukan progress persen yang dibuat-buat.

S04 menambahkan detail source/hash, unduh original/provenance. H1 sumber hanya disembunyikan jika benar-benar sama dengan judul metadata, bukan semua heading pertama. Gambar/HTML tetap tidak dieksekusi. Semua perubahan desktop/mobile wajib dibandingkan dengan mockup setelah browser tersedia; belum ada screenshot yang disetujui.
