# PRD — kebutuhan dan batas rilis

Acuan kebutuhan untuk pengembangan lokal dengan data sintetis. Status tiap requirement ada di [PLAN.md §5](PLAN.md); cara mencoba di [README](../README.md). Kontrak teknis berada di [ARCHITECTURE.md](ARCHITECTURE.md), visual di [UI.md](UI.md), bukti penerimaan di [PLAN.md](PLAN.md).

## 1. Tujuan dan pengguna

Karyawan memperoleh jawaban dokumentasi internal yang relevan, mutakhir, sesuai izin, dan bisa diverifikasi. Kontributor mudah menyumbang pengetahuan; reviewer tetap memegang keputusan validasi. AI membantu menemukan bukti, bukan menjadi pemilik kebenaran atau pelaksana perubahan sistem Telkom.

Lima role bawaan: **Super Admin, Admin Knowledge, Reviewer, Contributor, Viewer**. Role menentukan kemampuan; penugasan unit/kategori dan klasifikasi membatasi cakupannya. “Security” dalam contoh aturan adalah grup/domain atau role kustom, bukan role bawaan keenam yang sudah terdefinisi.

**MVP lokal** = alur end-to-end yang bisa diuji dengan login lokal dan data sintetis; bukan klaim siap produksi. **Pilot/MVP internal Telkom** = alur produksi terbatas dengan SSO/kebijakan data dan kontrol keamanan lengkap, bukan sekadar demo UI. **V1** = pelengkapan fungsi mockup setelah pilot. **Lanjut** = ekspansi enterprise yang tidak diperlukan untuk memvalidasi produk awal. Penundaan di bawah harus disetujui pemilik produk.

## 2. Keterlacakan seluruh bagian 1–11

| ID / bagian                | Pilot/MVP: kemampuan yang harus nyata                                                                                                                                                                               | V1 / lanjut: tetap tercatat                                                                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S01 · Halaman Muka         | Hero search, pintu chat, kategori, paling dibaca, publikasi terbaru; seluruh daftar dan hitungan sesuai akses. Topik kurasi saat data belum cukup.                                                                  | V1: topik populer dari log aman 30 hari; peringkat dan indikator kualitas berbasis pengukuran, bukan angka demo.                                                                       |
| S02 · Hasil Pencarian      | Kata kunci + semantik; kategori/label/format/waktu/status/pemilik; sort dan paginasi; draft sendiri terpisah. Jawaban ringkas bersitasi dipicu pengguna.                                                            | V1: permintaan akses melalui kanal/katalog yang memang boleh diketahui pemohon; jangan bocorkan judul terkunci. BM25 hanya jika kebutuhan terbukti.                                    |
| S03 · Katalog Dokumen      | Tabel seperti mentor; versi, pemilik, metadata, klasifikasi, status; filter, paginasi, draft sendiri, antrean sendiri; favorit dan riwayat baca pribadi.                                                            | V1: aksi massal terbatas dengan konfirmasi dan audit.                                                                                                                                  |
| S04 · Baca Dokumen         | Reader tiga kolom, navigasi heading, TOC, kode/tabel, versi immutable, metadata approval, lampiran/original download berizin, dokumen terkait, feedback dan usulan koreksi.                                         | V1: diff versi dan rollback menjadi draft baru. Review date/pengingat sudah ada pada pilot.                                                                                            |
| S05 · Unggah Knowledge     | Empat langkah; multi-file utama/lampiran; 50 MB per file; konversi→preview MD→metadata→submit. MD, TXT, PDF bertesks, DOCX, XLSX; exact-duplicate warning; kategori, label, pemilik, klasifikasi, reviewer.         | V1: PDF pindai/OCR gambar, PPTX, HTML, DOC legacy, ZIP terkendali; metadata AI dan kemiripan semantik. Tidak boleh menampilkan format nonaktif seolah didukung.                        |
| S06 · Approval Admin       | Antrean/detail; preview original dan hasil konversi; catatan, approve/request changes/reject; satu atau dua tahap; larangan self-approval; pemeriksaan malware/secret; audit; publikasi lalu indeks yang konsisten. | V1: bantuan AI kelengkapan/duplikasi, diff, @mention, bacaan wajib, email dan kanal internal setelah integrasi disetujui. Notifikasi dalam aplikasi sudah ada pada pilot.              |
| S07 · Kategori & Label     | CRUD kategori maksimum tiga tingkat, satu kategori leaf per dokumen, label multi; urutan melalui kontrol sederhana; cegah siklus/hapus kategori terpakai; aturan akses, Kritikal dua tahap, review/expiry.          | V1: drag-and-drop dengan alternatif keyboard; ekspor taksonomi, merge label, saran label mirip/tidak terpakai; bukan workflow-builder umum.                                            |
| S08 · Pengguna & RBAC      | Lima role, matriks izin, scope, aktivasi/nonaktivasi dan audit. Lokal memakai login credentials nyata; SSO/sinkron identitas wajib sebelum pilot Telkom. Reviewer tidak lintas cakupan.                             | V1: editor role kustom; undangan mengikuti IdP dan kebijakan mitra, bukan pendaftaran publik. Penyesuaian akses Rahasia mengikuti matriks di ARCHITECTURE §3.                          |
| S09 · AI Assistant         | Percakapan pribadi multi-turn; scope seluruh KB yang berizin/kategori/dokumen; sumber versi+lokasi; tidak ditemukan/konflik; status proses dan cancel; feedback; histori dengan recheck izin.                       | V1: tautan jawaban tetap berautentikasi, ekspor Markdown/draft, saran lanjutan. Lampirkan = pilih dokumen terpublikasi, atau unggah melalui approval; tidak ada jalur bypass.          |
| S10 · Dashboard            | Dokumen per status, aktivitas baca/chat, durasi approval, pencarian tanpa hasil, kontributor; filter periode/unit dan data aktual sesuai scope. Log kosong menampilkan empty state.                                 | V1: knowledge-gap teragregasi, penugasan penulis, laporan ekspor. Jangan menampilkan pertanyaan mentah sensitif pada dashboard lintas unit.                                            |
| S11 · Arsitektur & Roadmap | Menjadi dokumen arsitektur, proses end-to-end, risiko, keamanan, dan rencana ini; bukan layar aplikasi wajib.                                                                                                       | Lanjut: PWA tanpa cache konten sensitif, ticketing/chat, API untuk integrasi, dashboard eksekutif, ekspansi non-IT. Estimasi 5–6 bulan mentor bukan komitmen tim yang belum diketahui. |

Menu pendukung yang tidak punya layar tersendiri—favorit, riwayat, draft, notifikasi, audit, konfigurasi AI, pengaturan—memakai view/dialog kecil pada layout yang sama. Tiap tautan harus berfungsi atau jelas belum tersedia; tidak ada tombol dekoratif pada fitur yang dinyatakan selesai. Konfigurasi AI hanya untuk admin berwenang, tanpa menampilkan secret provider.

## 3. Kontrak alur utama

1. **Kontribusi:** contributor memilih kategori dan klasifikasi, mengunggah berkas; sistem memvalidasi, memindai, mengekstraksi, dan menyimpan MD beserta asalnya. Pengguna memeriksa hasil, mengisi metadata, lalu mengirim versi yang dibekukan.
2. **Validasi:** approver sesuai scope melihat isi, lampiran, dan temuan. Minta revisi/tolak wajib beralasan. Kategori berisiko, label Kritikal, atau klasifikasi tinggi memerlukan dua persetujuan berbeda. AI tidak menyetujui dokumen.
3. **Publikasi:** semua tahap dan pemeriksaan wajib lulus. Versi masuk staging indeks; baru menjadi aktif ketika indeks siap. Revisi baru tidak menghilangkan versi lama yang masih sah. Gagal indeks tidak boleh dilaporkan sebagai sukses publikasi.
4. **Konsumsi:** pembaca mencari, membaca, mengunduh, atau bertanya dalam cakupannya. AI memakai versi aktif yang sah; sitasi membuka bagian sumber. Bukti tidak cukup → mengaku belum ditemukan; sumber bertentangan → tampilkan konflik, bukan memilih tanpa dasar.
5. **Pemeliharaan:** pemilik mendapat pengingat; expired/withdrawn keluar dari jawaban default; feedback masuk antrean pemilik. Pembaruan mengikuti review lagi.

## 4. Aturan produk yang tidak bisa ditawar

- “Terbatas/Rahasia” adalah klasifikasi, bukan status workflow. Kedaluwarsa juga berbeda dari “perlu tinjau”. UI boleh menampilkan beberapa badge sekaligus.
- Dokumen tanpa izin tidak bocor lewat judul, cuplikan, hitungan, kategori, related docs, duplicate warning, autocomplete, ekspor, URL berkas, sumber AI, atau chat lama.
- Draft hanya terlihat oleh pemilik/kolaborator dan reviewer yang ditugaskan; tidak masuk retrieval AI pengguna, walaupun penanya adalah admin.
- Normalisasi menjadi MD tidak mengizinkan AI menulis ulang SOP sebagai fakta. Berkas asli tetap disimpan. Angka tabel, kode, unit, dan urutan langkah harus dapat diverifikasi.
- Semua materi lampiran mengikuti minimal klasifikasi dokumen induk dan review versi yang sama. Berkas tanpa teks/ekstraksi gagal tidak boleh diam-diam dianggap berhasil diindeks.
- Jawaban AI yang diekspor menjadi dokumen baru tetap berstatus draft, membawa provenance dan batas akses; tidak otomatis menjadi kebenaran baru di KB.
- UI boleh memakai fixture mentor di lingkungan demo yang dilabeli. Produksi tidak boleh memakai statistik, identitas, jawaban AI, atau hasil scan buatan.

## 5. Di luar scope awal dan definisi selesai

Tidak membangun editor kolaboratif ala Notion, sinkron GitHub, auto-docs dari kode, marketplace plugin, multi-tenant SaaS, chatbot dengan akses shell/SQL/action tools, atau konektor seluruh sistem Telkom. Satu organisasi dengan banyak unit sudah cukup.

MVP lokal dapat direview tanpa menunggu infrastruktur organisasi. Pilot Telkom selesai hanya jika M0–M4 dan gate Q1–Q6 lulus pada lingkungan yang sesuai, ada sampel dokumen yang sah, UAT mentor/pemilik pengetahuan, serta persetujuan keamanan dan operasi. “Mirip mockup”, “build berhasil”, dan “ada sitasi” masing-masing **belum cukup** untuk menyatakan siap digunakan.
