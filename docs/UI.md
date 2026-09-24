# UI — kontrak kesetiaan terhadap mockup

**Acuan utama:** [HTML mentor](../reference/intradocs-mockup_1.html). Bukan tema generik GitDoc/shadcn. Delta U01–U15 di bawah adalah perbedaan yang disengaja terhadap mockup beserta alasannya; semuanya dibuktikan dengan screenshot berdampingan (`pnpm ui:shots`), belum dengan diff piksel otomatis.

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
| U03   | Sembunyikan hasil tanpa izin. Status workflow, sensitivitas, freshness, dan status indeks tidak dicampur.                                                                                                                        |
| U04   | Pada approval tahap awal: “Setujui tahap ini”. Hanya approver terakhir melihat “Setujui & proses publikasi”. Tampilkan indexing/failed/ready secara jujur.                                                                       |
| U05   | Angka demo diganti data nyata atau “Belum ada data”. Jangan menampilkan “96% akurasi AI”, “0,18 detik”, “2,4 detik”, dan persentase kemiripan tanpa pengukuran yang benar.                                                       |
| U06   | Search, checkbox, select, tombol, dan composer menjadi elemen semantik yang berfungsi; fokus keyboard, label, dan kontras AA diperbaiki. Target sentuh minimal 44 px dengan hit-area, sebisa mungkin tanpa mengubah ikon visual. |
| U07   | Ringkasan AI pada search dibuat atas aksi pengguna, bukan setiap ketikan. Chat pilot mengirim status proses lalu jawaban tervalidasi; efek streaming token mentah bukan prioritas.                                               |
| U08   | Fitur/format V1 tidak berpura-pura aktif di pilot. Pesan yang jelas lebih baik daripada tombol mati atau sukses palsu.                                                                                                           |

Warna Telkom baru, dark mode, animasi tambahan, layout kartu generik, atau penyederhanaan yang menghapus metadata **bukan perubahan otomatis yang diizinkan**.

## 4. Responsive dan state wajib

Desktop lebar mengikuti mentor. Pada 1024 px, TOC jadi drawer dan antrean/detail approval menjadi tampilan master–detail agar kolom tidak terjepit. Pada sekitar 390 px, sidebar/filter menjadi drawer, grid menjadi satu kolom, metadata membungkus, stepper ringkas, composer tetap terlihat. Tabel/kode boleh scroll di wilayahnya; halaman tidak boleh overflow horizontal. TOC dan aksi penting tetap bisa diakses.

Login adalah layar pendukung baru dengan token mentor: form credentials pada local-dev, tombol SSO pada mode organisasi; tanpa social-login dekoratif atau role-picker bypass. AI tanpa key menampilkan belum aktif, bukan jawaban contoh yang menyamar sebagai inference nyata. Semua alur menguji loading, kosong, error/retry, izin dicabut, dan tidak ditemukan. Tambahan: upload sebagian gagal/cancel/file ditolak; OCR berkualitas rendah; reviewer conflict/revisi; indexing gagal; AI timeout/tidak cukup bukti/konflik/quota. Form tidak kehilangan input saat gagal; dialog mendukung Escape dan focus return; `⌘/Ctrl+K` pencarian tanpa mengganggu pengetikan. Jangan membawa shortcut panah navigasi deck ke reader/editor.

## 5. Pembuktian visual

1. Bekukan HTML asli; gunakan fixtures dan waktu demo tetap. Lingkungan browser, font, zoom, dan DPR yang sama; baseline dari area `.app` setiap `#s1`–`#s10`.
2. Pada viewport desktop 1480 px, ukur bounding box area aplikasi referensi; samakan ukuran area aplikasi implementasi, jangan membandingkan viewport deck dengan aplikasi fullscreen secara langsung. Uji pula 1024 dan 390 px; layout mobile dinilai terhadap delta yang disetujui, karena tidak ada desain mobile lengkap dari mentor.
3. Ambil snapshot tiap layar, bagian bawah inner-scroll, tab/dialog penting dan state gagal; periksa satu per satu. Delta U01–U08 dicatat, bukan disembunyikan dengan mask seluruh area.
4. Target awal diff ≤1% pada area stabil setelah normalisasi; selalu review side-by-side. Threshold bukan izin mengabaikan pergeseran layout, teks salah, clipping, atau aksesibilitas.
5. Simpan snapshot/bukti di PR implementasi.

**Dijalankan (September 2026).** `pnpm ui:shots` (`scripts/ui-shots.ts`, Playwright Chromium headless) memotret area `.app` setiap `#s1`–`#s10` mockup dan semua halaman portal sebagai satu akun sintetis pada viewport yang sama (1440 px; `SHOT_W=390` untuk pass mobile) ke `var/shots/`. Dari perbandingan berdampingan itu, layar yang tadinya jauh dari mockup dibawa kembali: S06 approval menjadi master–detail dengan keputusan, temuan pra-cek, pratinjau dan timeline; S02 facet berjumlah dan highlight; S03 chip filter dan tabel berlabel; S04 kaki halaman ringkas; S07 tree berhitung dan form di balik tombol; S09 avatar, kartu sumber bernomor dan composer menempel; S10 chart CSS dari angka nyata. Yang sengaja tetap berbeda (delta U01–U08) tidak berubah: tidak ada angka demo, tidak ada toggle yang tidak berfungsi (aturan ditampilkan sebagai baris centang, bukan switch), dan konten di luar izin tidak pernah dirender. Belum ada diff piksel otomatis; buktinya adalah screenshot yang dibandingkan orang.

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
- **Jawaban tampil saat ditulis** (docs/WEKNORA.md §27): gelembung pertanyaan langsung
  terpasang, jawaban tumbuh dengan kursor berkedip dan label "Menyusun jawaban… diperiksa dulu
  sebelum final", lalu diganti hasil akhir beserta sumber dan chip.
- Callout **"Sumber tidak sepakat"** bila dua dokumen yang dikutip menyebut angka berbeda
  untuk hal yang ditanyakan, dengan nilai per dokumen.
- Halaman unggah menampilkan chip **PPTX** hanya bila WeKnora aktif (parser-nya); katalog dan
  pencarian mengenal format itu (label "PowerPoint", badge oranye).

Bukti: `var/chat-shots2.mts` (katalog, penolakan dengan kutipan dan chip), `var/pending-shot.mts`
(Hentikan), `rag:eval --chat` dan tes di §25.

## Delta U12 — gate aksesibilitas Q5 (September 2026)

`tests/e2e/a11y.spec.ts` menjalankan axe (wcag2a/aa, wcag21aa, best-practice) pada login dan
S01–S10 + notifikasi/akses/pengaturan, desktop dan ponsel; **serious/critical = gagal**,
moderate/minor dicetak. Plus jalur keyboard-only: login (Tab–Tab–Enter), skip link → `main`,
pencarian dari keyboard, laci sidebar di ponsel (Enter buka, Escape tutup), dialog role (Enter
buka, Tab tetap di dalam, Escape tutup). Yang diperbaiki agar lulus — semuanya perubahan kecil
pada lapisan tema, bukan struktur mentor:

- `--muted-2` #8b95a7 → #667085 (label kecil 11–12 px gagal 4,5:1 di atas kartu putih).
- Biru aksen di atas tint-nya sendiri (chip filter aktif, tag kategori biru) 3,9:1 → memakai
  `--accent-ink`.
- Tautan facet pencarian memakai `aria-current`, bukan `aria-pressed` (tidak valid pada `<a>`).
- Blok draf ringkasan yang bisa digulir mendapat `tabIndex=0` + label; `main` (wilayah gulir
  utama) `tabIndex=0` dengan ring fokus hanya pada `:focus-visible`.
- Satu `h1` per halaman: judul asisten jadi `h1`, tagline login jadi `p` dan "Masuk ke
  IntraDocs" jadi `h1`.
- Landmark: panel samping approval bukan `aside` bersarang; dua wilayah tabel di S08 punya
  label berbeda.

Sisa temuan moderate: tidak ada. Load test Q5 tetap menunggu hardware target.

**Perbaikan (14 September 2026): riwayat tidak bisa dihapus.** Dua sebab: tombol × pada baris
riwayat baru terlihat saat hover (`opacity: 0`) — di layar sentuh tidak pernah muncul — dan
penghapusan memakai `window.confirm()`, yang di beberapa browser tersemat ditolak diam-diam
sehingga tidak terjadi apa-apa. Kini × selalu terlihat (redup saat diam, penuh saat hover/fokus
dan pada perangkat tanpa hover), dan konfirmasi terjadi **di dalam baris** ("Hapus percakapan
ini? Hapus / Batal") tanpa dialog native. Tes e2e `portal.spec.ts` menghapus percakapan sambil
menolak setiap dialog native, desktop dan ponsel. 350 percakapan sisa eval/probe dibersihkan
dari akun demo.

## Delta U13 — peran warna, empat lapisan, status yang terlihat (14 September 2026)

Review desktop 1440×900 atas 30+ layar untuk lima role menemukan tiga sebab "monoton": satu
hue biru-violet untuk semua peran (aksi, nav, tautan, avatar, AI, KPI), kartu putih di dalam
kartu putih, dan blur pada kartu yang tidak punya apa-apa untuk dikaburkan. Ditambah: tidak ada
toast, bel hanya titik, dan tiga halaman masih mentah. Lapisan baru `apps/web/src/app/depth.css`
(dimuat terakhir) menetapkan:

- **Peran warna.** `--accent` (satu aksi utama per layar, nav aktif, tautan); `--ai` gradien
  violet→magenta khusus asisten (tombol Tanya AI di topbar, hero, avatar, kartu AI di search dan
  reader, saran perapian taksonomi, baris audit `rag.*`); `--flow-review/ok/block/draft` untuk
  posisi dalam alur — chip status, tint baris, ikon notifikasi, timeline; enam warna kategori
  tetap. Badge format satu keluarga tint (`.ft-md` indigo, bukan kotak hitam).
- **Empat lapisan.** L0 latar dengan tiga orb (dua dingin, satu hangat di kanan bawah); L1
  kartu 92 % putih **tanpa blur**; L2 _sunken_ untuk apa pun di dalam kartu (`.card .card`,
  kartu asisten dan kartu masukan di artikel, preview approval, chip label); L3 hanya yang
  melayang (topbar, sidebar, menu, dialog, composer, popover bel, toast) yang diblur. Dialog role
  tidak lagi berbingkai ganda.
- **Fokal.** "Tanya AI" di topbar jadi ikon saja di home (hero sudah punya); "Nonaktifkan" ×7
  jadi tersier (teks merah, bingkai saat hover) dengan konfirmasi inline, bukan `confirm()`;
  kategori kosong di home meredup; peringkat #1 saja yang bergradien.
- **Status.** Toast global (`components/toast.tsx`, empat nada, 4 detik) setelah favorit,
  tandai dibaca, ajukan/putuskan akses, keputusan review, submit, role, status akun. Popover
  bel (5 terbaru, ikon+warna per jenis, "Tandai semua" → `POST /api/notifications`). Halaman
  Notifikasi: ikon per jenis, titik belum-dibaca, grup Hari ini / 7 hari / Sebelumnya, tanda ✓
  per baris, "Tandai semua dibaca". "Menunggu Anda" di home jadi strip chip berwarna
  (review amber, notifikasi biru, draft slate), hilang bila kosong.
- **Reader.** Latar `doc-main` transparan (kartu terpisah dari tanah), teks isi 15,5 px/1,76,
  measure 800 px; kartu "Tanya asisten" L2 ber-tint AI; draf ringkasan model terlipat
  (`details`) — hanya pemilik yang membukanya.
- **Halaman mentah.** Bandingkan versi memakai shell dokumen (rail kiri + satu kartu), ringkasan
  diff sebagai chip +/−, empty state bila baru satu versi. Permintaan Akses dua kolom (daftar
  kiri, form ≤380 px kanan), chip status berwarna, level akses sebagai chip pilihan, yang sudah
  diputus pindah ke "Riwayat keputusan". Tombol "Filter" khusus ponsel tidak lagi bocor ke
  desktop (`.search-filters label{display:grid}` menimpa `display:none`). "Filter tidak valid"
  memakai empty state.
- **Motion.** Satu `rise` 220 ms saat halaman tiba; dihormati `prefers-reduced-motion`.
- **Teks.** Login: SSO + akun demo + privasi jadi dua baris; penjelas di kartu asisten dan
  draf ringkasan dipangkas; bantuan form akses satu kalimat.

Perbaikan ikutan: daftar bernomor yang diselingi bullet oleh model kini terus dihitung
(`answer-text.tsx` memberi `start`), bukan "1., 1."; `WeknoraParseConverter` memakai field
eksplisit agar `node --test` (strip-only TypeScript) bisa memuatnya. Gate a11y tetap lulus
(desktop + ponsel) setelah dua koreksi: toggle facet keluar dari pohon di desktop, titik
belum-dibaca `aria-hidden` + teks sr-only, `--flow-ok-ink` #086b4a agar chip hijau tetap
4,5:1 di baris yang di-hover.

## Delta U14 — material kaca yang terlihat (14 September 2026)

Setelah U13 masih terasa satu bidang putih: tint 3–10 % di atas latar 96 % putih tidak
membedakan navbar, sidebar, tombol, dan kartu. Lapisan ketiga
`apps/web/src/app/glass.css` (dimuat terakhir) mengerjakan **material**, bukan warna peran:

- **Latar berwarna nyata** — mesh empat orb (biru 34 %, violet 30 %, peach 20 %, teal 18 %)
  di atas #edf1fb, `background-attachment: fixed`, sehingga kaca punya sesuatu untuk
  dibiaskan dan tepi putih punya tempat berpijak.
- **Satu resep kaca**: gradien putih 82→68 % (kartu) atau 90→78 % (melayang),
  `saturate(180%) blur(22px)`, highlight specular 1 px di tepi atas, ring gelap 8 %, dua
  bayangan (dekat 2 px, jauh 36 px). Nested tetap _sunken_ (4 % gelap, tanpa blur).
- **Navbar**: search `position:absolute` di tengah sejati (lebar `min(560px, 38vw)`; kembali
  ke aliran flex di bawah 1100 px); kbd **Ctrl K** (⌘ K hanya di Mac, dibaca lewat
  `useSyncExternalStore` saat hidrasi); bel, akun, dan hamburger jadi pil kaca berbingkai;
  Tanya AI pil violet; garis bawah 10 % + bayangan.
- **Sidebar**: panel ber-tint indigo 86→72 %, border kanan 10 %, bayangan ke kanan; item
  aktif pil putih dengan ring biru + bar kiri; hover putih 75 %; kartu status lingkungan;
  laci ponsel 97 % (tidak tembus).
- **Kontrol**: `.btn` sekunder = kaca 98→88 % + border 14 % + bayangan + highlight; primer
  gradien + ring + glow; hijau/merah bahaya sama polanya; tersier merah tetap ghost. Input
  border 16 % dengan ring fokus 4 px; `select` mempertahankan chevron (`background-color`,
  bukan `background`). Chip, tag, summary-as-button, dan choice memakai kaca berbingkai.
- **Tabel**: header 5 % kapital kecil, baris hover 6 % aksen, radius 14 px pada wrapper.
- **Per halaman**: hero home = panel kaca 24 px dengan mesh sendiri + search 97 % dengan
  bayangan jauh; kartu kategori memakai garis atas warna kategori (`--tone`) dan tile ikon
  `color-mix`; reader = rail kiri kartu kaca _sticky_, artikel kertas 94 %, TOC/riwayat
  kartu; login = kartu kaca melayang di atas mesh (panel kanan transparan); asisten = rail
  ber-tint violet, judul gradien, gelembung user violet, composer kaca tebal + bayangan
  jauh; approval = rail ber-tint amber, item aktif ring amber; pengguna = garis atas warna
  role; dashboard = tile KPI kaca; **Pengaturan** = kartu profil + grid tile fakta dengan
  ikon dan chip status (menggantikan daftar `dl`).
- **Teks**: catatan login jadi satu paragraf dengan ikon; SSO satu baris di bawah tombol.

Perbaikan ikutan dari pengujian: konfirmasi hapus percakapan menyebut judulnya
(`Hapus “Backup”?`) sehingga baris tetap dikenali; tes e2e menunggu respons DELETE lewat
`expect.poll` (sebelumnya balapan). **Migrasi 036**: policy `audit_read` untuk knowledge
admin memakai `document_id IN (SELECT … WHERE app.can_read_document(id))` — dievaluasi
sekali per statement (hashed SubPlan) alih-alih per baris; pada ~3.500 event audit,
dashboard Andi sebelumnya melewati `statement_timeout` 5 s (503), kini ±160 ms. Gate a11y +
keyboard, portal e2e, HTTP 101, unit 315 lulus.

**Putaran ketiga (14 September 2026, setelah uji pengguna).** Kunjungan ulang tiap halaman
di build produksi: sambutan asisten kini di tengah thread kosong (bukan menempel atas dengan
ruang kosong di bawah); halaman approval tanpa pilihan menampilkan empat aturan reviewer
sebagai tile (bukan daftar bernomor + paragraf); ikon audit dalam tile ber-tint per keluarga;
grafik aktivitas dashboard menjadi garis waktu 14 hari penuh (hari sunyi digambar kosong,
bukan dilewati) dengan seri AI berwarna violet; bantuan metadata di unggah ber-tint AI; empty
state tingkat halaman (masukan, akses ditolak, satu versi) berdiri di kartu kaca. Data uji:
`tests/http/versions.test.ts` kini menghapus notifikasi dan draft sisa alurnya sendiri
(dokumen "Uji versi" tetap dicabut karena audit trail merujuknya), sehingga "Draft & Revisi
Saya" milik contributor demo bersih dari 5 baris "Dicabut".

**Data demo (14 September 2026): revisi nyata dokumen VPN.** Lewat API aplikasi sendiri
(`var/vpn-revision.mts`): Rizky mengunggah revisi "Konfigurasi VPN" dengan bagian baru "Jika
perangkat authenticator hilang" dan verifikasi DNS, mengajukannya ke Andi, Andi menyetujui
dengan alasan, worker menerbitkan dan mengindeks. Hasilnya: reader menampilkan v1.1 aktif +
v1.0 "versi lama", tombol **Bandingkan versi** muncul dan diff-nya terbaca (+11/−1 baris), dan
asisten kini menjawab pertanyaan authenticator dari bagian baru itu. Dua perbaikan ikutan:
**migrasi 037** — label revisi mengikuti skema dokumen (`1.0`→`1.1`, `3.2`→`3.3`; dokumen yang
mulai di `0.1` tetap `0.2`, `0.3`) lewat `app.next_label()`, karena `'0.'||n` membuat revisi
pertama dokumen seed "1.0" berlabel "0.2"; dan tabel diff memakai `<colgroup>` — dengan
`table-layout: fixed`, caption `sr-only` (display:block) membuat Chrome membagi empat kolom
sama lebar sehingga nomor baris memakan separuh tabel.

**Putaran keempat (14 September 2026): keadaan interaktif.** Kunjungan per halaman kali ini
membuka menu, dialog, form, dan panel yang terlipat — bukan hanya tampilan awal:

- **Undang Pengguna**: form popover memakai bahasa field yang sama dengan dialog role (label
  tebal, chip cakupan dengan "Semua kategori", tombol × di kepala, "Batal" bukan "Tutup");
  sebelumnya checkbox native dalam fieldset berbingkai dan legend yang bertumpuk.
- **Dialog role** menyebut orangnya (avatar + nama) di kepala, jadi tidak ada keraguan siapa
  yang sedang diubah.
- **Kategori & Label**: chip label dikelompokkan per kategori (dua "Kritikal" dan dua
  "Runbook" sebelumnya tampak duplikat tanpa penjelasan); membuka form kategori/label
  menggulir ke form-nya (sebelumnya klik "+ Kategori baru" di atas tidak mengubah apa pun di
  layar karena form muncul di bawah lipatan).
- **Reader**: "Asal berkas & integritas" dan "Alat pemilik…" tidak lagi kotak berbingkai
  saat tertutup — hanya chip; kotak muncul saat dibuka. Pertanyaan asisten dua kolom; teks
  keterangan di kartu-kartu dalam artikel memakai ukuran keterangan, bukan ukuran prosa.
  Panel alur: chip status per tahap (Disetujui/Ditolak/Minta revisi/Menunggu) + "Tahap n dari
  N"; catatan "Publikasi: Indeks siap. Percobaan 1/5" dibuang bila sudah terbit (chip
  Published di kepala sudah mengatakannya); versi lama terbaca "versi lama", bukan `approved`.
- **Unggah langkah 3**: pratinjau _sunken_; baris konfirmasi "file contoh tanpa data nyata"
  menjadi baris amber yang berubah hijau saat dicentang.
- **Popover** (akun, bel, filter, undangan) hampir opak — sebelumnya tombol dan chip di
  belakangnya terbaca menembus menu.
- **Asisten**: kalimat yang disalin model dari instruksinya sendiri ("Riwayat percakapan
  hanya untuk memahami maksud pertanyaan, bukan sumber fakta.") dibuang sebelum jawaban
  ditampilkan (`stripPromptEchoes`, `packages/core/src/rag.ts`); jawaban yang tinggal
  gema saja mengambil jalur "tidak ada jawaban langsung".
- **Notifikasi**: **migrasi 038** — notifikasi "Anda ditugaskan mereview" ditandai dibaca
  saat reviewer memutuskan atau pengajuan dibatalkan revisi baru; sebelumnya badge Andi
  menunjukkan 6 dengan satu item di antrean. Backlog seed Rizky (13 notifikasi "terbit"
  dari data awal) ditandai dibaca; yang tersisa hanya yang relevan untuk demo.

## Delta U15 — role kustom (20 September 2026)

**Keputusan desain.** Rencana awal menaruh role kustom di luar rilis karena lima role
bawaan tertanam di 41 ekspresi policy RLS (`app.actor_role()`), dan mengganti itu dengan tabel
kemampuan berarti mendesain ulang lapisan izin database. Yang dibangun sekarang **tidak**
menyentuh policy: sebuah role kustom adalah _nama_ di atas **satu role dasar** (Admin Knowledge,
Reviewer, Contributor, atau Viewer) ditambah daftar kemampuan yang **dicabut**. Database tetap
menegakkan role dasar (batas baca klasifikasi/cakupan/grant tidak berubah); aplikasi menolak
kemampuan yang dicabut pada setiap permintaan lewat `requireActor`/`requireApiActor` — gerbang
tunggal yang dipakai semua halaman dan route. Role kustom **tidak pernah menambah** apa pun:
server menolak pencabutan kemampuan yang memang tidak dimiliki role dasarnya.

- **Migrasi 039** — `app.custom_roles` (nama unik selama aktif, warna, deskripsi, `base_role`,
  `denied_capabilities` ⊂ kemampuan, `revision`, `archived_at`), kolom `custom_role_id` di
  `profiles` dan `invitations`, trigger yang memastikan role bawaan profil = `base_role` role
  kustomnya, fungsi `save_custom_role` / `archive_custom_role` (super admin saja),
  `assign_user(...,custom_role)`, `create_invitation(...,custom_role)`, `open_invitation`
  mengembalikan nama role, `accept_invitation` mewarisi role kustom (yang sudah diarsip jatuh
  ke role dasar). Role dasar **terkunci** selama ada pemegang; arsip ditolak selama ada pemegang
  atau undangan terbuka. Audit: `role.created/updated/archived`. **Migrasi 040** — grant kolom
  untuk `intradocs_workflow`.
- **Core** — `effectiveCapabilities(role, denied)`, `Actor.capabilities` (dihitung
  `loadActor` per permintaan, jadi perubahan definisi berlaku di halaman berikutnya tanpa
  login ulang), `Actor.customRole`, `roleLabel(actor)`, `CAPABILITY_LABELS`,
  `parseCustomRole` (`packages/core/src/roles.ts`).
- **API** — `GET/POST /api/roles`, `PATCH/DELETE /api/roles/:id` (revisi optimistik → 409);
  `POST /api/users/:id/assignment` dan `POST /api/invitations` menerima `customRoleId`.
- **UI (S08)** — kartu role kustom di samping lima kartu bawaan: chip kemampuan yang
  dipertahankan + chip merah dicoret untuk yang dicabut, jumlah pemegang, Edit/Arsipkan
  (arsip nonaktif selama ada pemegang, konfirmasi inline); kartu "+ Role kustom baru" membuka
  dialog kaca: nama, warna, deskripsi, role dasar (chip radio; terkunci bila ada pemegang),
  checklist kemampuan yang dipertahankan (hanya kemampuan role dasar). Dialog penugasan dan
  form undangan memuat `optgroup` "Role kustom" (`Nama · berbasis X`). Kolom Role di tabel
  pengguna menampilkan nama kustom (ungu) + "berbasis X"; topbar, menu akun, Pengaturan, dan
  halaman terima-undangan menampilkan nama kustom.
- **Uji** — `tests/unit/roles.test.ts` (aritmetika kemampuan, parser, label);
  `tests/http/roles.test.ts` lewat aplikasi nyata: hanya super admin yang mendefinisikan,
  pencabutan di luar role dasar ditolak (400), role kustom harus cocok dengan role bawaan
  saat ditugaskan (422), pemegang kehilangan `documents.upload` pada permintaan berikutnya
  (403 di API, halaman unggah menolak) sementara `profiles.role` tetap `contributor`,
  mengubah definisi memulihkannya tanpa login ulang, revisi basi → 409, arsip ditolak selama
  dipegang, jejak audit `created → updated → archived`. Dicoba juga lewat UI: role
  "Penulis SOP" (Reviewer tanpa Review & persetujuan) ditugaskan ke Dwi → topbar "Penulis
  SOP", menu Antrean Persetujuan hilang, `/admin/approval` → Akses tidak tersedia.

Yang sengaja **tidak** dibuat: role kustom yang _menambah_ kemampuan atau melampaui batas
baca role dasarnya — itu tetap membutuhkan desain ulang policy dan review keamanan.
