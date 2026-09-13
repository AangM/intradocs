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

## Delta U09 — tema "glass", topbar berisi, beranda bertanya ke AI (September 2026)

Diminta pengguna setelah melihat hasil §5 di desktop: struktur sudah sama dengan mockup,
tetapi tampilannya "raw", banyak teks penuh, navbar kosong, dan beranda punya kotak cari yang
tidak langsung bertanya ke AI. Delta ini **melanggar kalimat di §3** ("animasi tambahan,
layout kartu generik … bukan perubahan otomatis yang diizinkan") atas keputusan pengguna
sendiri, dan dibatasi agar tetap bisa dicabut: satu berkas, tanpa mengubah struktur.

- **`apps/web/src/app/theme.css`**, dimuat terakhir di `layout.tsx`, adalah seluruh lapisan
  visual: token aksen gradien (`#3b6cf6 → #6a5cf5`), latar mesh radial halus, topbar dan
  sidebar `backdrop-filter` (glass), kartu dengan bayangan lembut, tombol primer bergradien,
  ring fokus, transisi 160 ms, dan `prefers-reduced-motion` mematikan semua transisi. Hapus
  satu baris `import './theme.css'` dan portal kembali ke token mentor §2 apa adanya. Token
  §2 tidak diubah; warna Telkom dan dark mode tetap tidak ada.
- **Topbar (S01–S10)**: topnav teks yang dulu kosong diganti pencarian di tengah
  (`⌘/Ctrl+K` tetap), tombol "Tanya AI" (hanya bila AI aktif), lonceng notifikasi dengan titik
  bila ada yang menunggu, dan menu akun (`<details>`: pengaturan & status fitur, dokumen
  favorit, keluar). Di ≤768 px tombol dan teks nama disembunyikan, avatar dan lonceng tetap.
- **Beranda (S01)**: kotak besar hero mengirim ke `/ai-assistant?ask=1` dan pertanyaan
  langsung dikirim (sekali per pemuatan, URL dibersihkan) — lihat docs/WEKNORA.md §16;
  tautan kecil "Buka pencarian dokumen" di bawahnya untuk yang hanya ingin mencari kata. Bila
  AI tidak aktif, kotaknya kembali menjadi pencarian. Baris statistik: dokumen resmi, kategori,
  pembaruan terakhir (relatif), AI aktif — semuanya angka nyata (U05 tetap). Kartu kategori
  memberi afordansi "Buka →" saat hover.
- **Diet teks**: subjudul halaman dan catatan kaki (audit, akses, umpan balik, notifikasi,
  pengaturan, unggah, katalog, pencarian, asisten) dipendekkan menjadi satu kalimat tentang
  apa yang dilihat orang, bukan tentang batas sistem; penjelasan batas pindah ke docs. Tidak
  ada metadata yang dihapus dari tabel atau kartu (U03/U05 tetap).
- **Asisten (S09)**: pertanyaan lanjutan kini punya konteks (docs/WEKNORA.md §24). Daftar sumber
  menampilkan tiga kutipan pertama dan melipat sisanya di balik "Tampilkan n kutipan lagi" — enam
  kartu kutipan penuh membuat jawaban tenggelam; baris statistik dan placeholder composer
  dibahasakan ulang ("dicari di 9 versi · 4 kutipan disaring", "Tulis pertanyaan lanjutan…").
- **Login**: panel cerita dipusatkan vertikal (dulu logo di atas dan setengah layar kosong),
  tiga poin nilai dalam bahasa pengguna (jawaban bersumber, sesuai akses, selalu versi resmi)
  menggantikan "session server + row-level security", ditambah satu kartu contoh tanya-jawab
  yang berlabel **Contoh · dokumen sintetis** (bukan inferensi nyata, sesuai §4). Catatan teknis
  di kanan dipadatkan menjadi dua baris. Di ponsel form mulai tepat di bawah logo.
- **Pencarian (S02) di ponsel**: facet dilipat di balik tombol "Filter" (checkbox CSS, tanpa JS)
  agar hasil tidak terdorong 600 px ke bawah; di desktop tidak berubah. Kaki kartu AI menjadi
  tombol "Minta jawaban tersusun" dan satu baris angka.
- **Topbar di ponsel**: sub-judul logo dan teks "Tanya AI" disembunyikan (ikon dengan
  `aria-label` tetap), jarak dirapatkan; avatar tidak lagi terpotong di tepi kanan.

Bukti: `pnpm ui:shots` (desktop 1440 dan `SHOT_W=390`) dijalankan ulang setelah delta ini; tidak
ada perbandingan piksel dengan mockup untuk lapisan glass karena memang sengaja berbeda.

## Delta U10 — asisten sebagai aplikasi chat, sidebar yang bisa ditutup, dialog (September 2026)

Setelah U09 pengguna meminta asisten yang "setara UI WeKnora / gitdoc / Claude / GPT", sidebar
yang bisa ditutup dan menyorot halaman aktif, serta dropdown yang tidak mentah. Rujukan yang
dipilih: **pola Claude/ChatGPT** (rel riwayat kiri, utas tengah maksimum 780 px, composer
menempel di bawah), dengan **chip sumber ala Perplexity** di bawah setiap jawaban — bukan
layar S09 mockup yang menaruh enam kartu kutipan penuh di bawah jawaban. Struktur S09 mentor
(riwayat/cakupan kiri, pesan, composer) tetap dikenali; yang berubah adalah proporsi dan
kepadatan.

- **`apps/web/src/app/chat.css`** (dimuat setelah theme.css): halaman asisten setinggi
  viewport, rel riwayat 272 px, utas menggulir sendiri, composer glass berbentuk pil dengan
  chip cakupan dan tombol kirim bulat, sapaan pertama ("Halo, Andi. Ada yang bisa saya
  bantu?") dengan empat kartu pemantik. Pertanyaan pengguna sebagai gelembung kanan, jawaban
  dalam kartu glass dengan avatar spark; **sumber sebagai chip per dokumen** (`×n` bila
  beberapa kutipan) dan "Lihat n kutipan" membuka daftar kutipan lengkap. Aksi jawaban jadi
  ikon dengan tooltip. Di ponsel rel riwayat menjadi laci (checkbox CSS, tanpa JS).
- **Sidebar portal**: entri dengan query (`/katalog?view=favorites`, `?status=mine`,
  `?category=`) kini menyala sesuai `useSearchParams` — "Favorit" dan kategori tidak pernah
  menyorot sebelumnya. Tombol ☰ di topbar: di desktop **melipat sidebar menjadi rel ikon**
  (diingat di `localStorage`, ikon dengan `title`), di ponsel membuka **laci** dengan latar
  gelap; menutup lewat latar, tombol ×, Escape, atau navigasi. Struktur di globals.css,
  tampilan di theme.css.
- **Edit penugasan role** (S08): `<details>` yang mengembang di dalam sel tabel diganti
  `<dialog>` native glass (terpusat, Escape/latar menutup): pilihan role sebagai select
  bertema, cakupan kategori sebagai chip pilihan.
- **Select dan disclosure**: semua `select.inp` memakai chevron sendiri (appearance none);
  menu chip filter, panel akun, dan kartu undangan memakai permukaan glass; `summary` dari
  `source-evidence`, `editor-tools`, `version-history`, `withdraw-panel`, dan editor
  taksonomi tampil sebagai tombol pil dengan caret berputar, bukan teks dengan segitiga.
- **Konteks pertanyaan lanjutan** ("jelaskan lebih lengkap"): bukan UI — lihat
  docs/WEKNORA.md §24.
- **Beranda (S01) dipadatkan.** Delapan bagian menjadi lima: hero → "Menunggu Anda" (hanya
  bila ada pengajuan/notifikasi/draft) → bacaan wajib (bila ada) → kategori → dua kolom "Baru
  diterbitkan" | "Paling dibaca" → footer. Yang dihapus karena redundan: baris statistik
  (angkanya kini satu baris di badge hero), banner AI (hero sudah bertanya ke AI), dan
  "Dokumen terbaru" (daftar yang sama dengan "Mulai membaca"). Chip topik kini **bertanya ke
  asisten** — label pendek, pertanyaan lengkap di baliknya (`STARTER_TOPICS`; topik terukur
  dibungkus "Apa yang dijelaskan dokumen tentang …") — dan kembali ke pencarian bila AI mati.
  Kartu kategori: ikon kiri, deskripsi dua baris; di ponsel menjadi ubin dua kolom tanpa
  deskripsi. Sapaan nama depan di judul. Kontributor melihat ajakan "Punya dokumen baru?".

Bukti: `var/chat-shots.mts` (desktop 1440 dan 390 px: pending, utas dua giliran, kutipan
terbuka, laci ponsel, rel terlipat, dialog role), `tests/e2e` rag + portal 14/14. Riwayat
percakapan akun demo siti dibersihkan dari 93 pertanyaan sisa tes; `tests/e2e/rag.spec.ts`
kini menghapus percakapannya sendiri di `afterAll`.

## Delta U11 — asisten yang menjawab lebih penuh dan tidak buntu (September 2026)

Bukan perubahan visual besar; yang berubah adalah _apa_ yang ditampilkan di gelembung
jawaban, dan itu diputuskan di server (docs/WEKNORA.md §25):

- Sapaan, "kamu bisa apa?", terima kasih, dan pertanyaan katalog ("apa ada dokumen lain yang
  menarik?") dijawab tanpa model, dari daftar dokumen yang boleh dibaca — bukan "tidak ada
  sumber".
- Setiap jawaban membawa **chip pertanyaan lanjutan** (pertanyaan hasil ingest untuk dokumen
  yang dikutip, dirapikan) — sekali klik langsung ditanyakan — dan, pada abstain atau jawaban
  katalog, **chip "Mungkin terkait" / "Dokumen"** yang membuka reader.
- Penolakan model tidak lagi satu kalimat kosong: "Yang disebutkan materi: …" bila model
  sempat mengutip, dan **kutipan verbatim passage terdekat** sebagai blok kutip. Teks abstain
  murni menyarankan kata lain atau "dokumen apa saja yang ada?".
- Jawaban pertanyaan templat kini berupa langkah bernomor dan daftar syarat, bukan satu
  kalimat (prompt "lengkap", 8 passage, `num_ctx` 8192, repeat penalty 1,02, chunk ringkasan
  bukan bukti).

- Tombol **Hentikan** di samping indikator "Mencari…" membatalkan permintaan yang berjalan
  (PRD S09 "status proses dan cancel"); composer langsung bisa dipakai lagi.

Bukti: `var/chat-shots2.mts` (katalog, penolakan dengan kutipan dan chip), `var/pending-shot.mts`
(Hentikan), `rag:eval --chat` dan tes di §25.
