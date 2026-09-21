# IntraDocs · M1–M5 lokal

Portal knowledge base **local-dev, corpus sintetis, AI opt-in dan off secara default**. Melanjutkan `intradocs-m3-work-checkpoint.zip`, bukan prototipe pengganti. Desain mentor, stack pinned, dan migrasi 001–017 dipertahankan.

## Hasil implementasi

- **M1:** Better Auth/session lokal, lima role, category scope, RLS PostgreSQL, proteksi URL/file, audit, shell responsif, penugasan role/scope dan aktivasi akun.
- **M2:** MD/TXT/PDF berteks/DOCX/XLSX/HTML (+ PPTX lewat parser WeKnora bila aktif, [§27](docs/WEKNORA.md)), original + maksimal empat lampiran, scan ClamAV wajib, converter non-AI, canonical gabungan dan provenance/locator, preview, private draft, duplicate/idempotency, retry, revisi immutable, taksonomi.
- **M4:** WeKnora lokal sebagai mesin RAG di belakang policy gate IntraDocs — ekspor idempoten versi final-approved, retrieval ber-scope, sitasi yang divalidasi ulang ke database pada setiap request, dan abstain bila tidak ada bukti sah. Aktif hanya bila `AI_PROVIDER=weknora-local` diisi sendiri. Rinciannya di [docs/WEKNORA.md](docs/WEKNORA.md).
- **M5 (V1):** saran label dari auto-tag WeKnora yang disaring kosakata kategori (tidak pernah diterapkan otomatis), permintaan akses dengan keputusan tercatat, bacaan wajib per kategori dengan konfirmasi versi, aksi cabut massal yang atomik, rollback versi via draft, merge label sebagai alias, gerbang relevansi yang membuat asisten menjawab "tidak tahu" pada pertanyaan tanpa bukti, metrik AI dari jejak audit di dashboard, cakupan jawaban (seluruh KB / kategori / dokumen yang dibuka) dan riwayat percakapan yang tunduk RLS di asisten, kartu sumber AI di halaman pencarian ([docs/WEKNORA.md §16](docs/WEKNORA.md)), summary dan pertanyaan yang dihasilkan WeKnora saat ingest sebagai saran — pertanyaan untuk pembaca, draf ringkasan hanya untuk yang boleh merevisi ([§17](docs/WEKNORA.md)), penilaian jawaban dan pertanyaan tak terjawab sebagai knowledge gap ([§18](docs/WEKNORA.md)), perapian taksonomi ([§19](docs/WEKNORA.md)), bantuan metadata saat unggah tanpa mengirim draft ([§20](docs/WEKNORA.md)), dan undangan pengguna lokal dengan tautan sekali pakai ([§21](docs/WEKNORA.md)).
- **M3:** satu/dua reviewer berbeda, larangan self-approval, justifikasi temuan, minta revisi/tolak, outbox ber-lease/retry, publikasi dan indeks atomik, lexical search ber-RLS, favorit, feedback pemilik, histori, notifikasi, pengingat/expiry, dokumen terkait, dan KPI aktual berfilter periode/unit.

**Bukti dan batas acceptance hanya pada [docs/PLAN.md §0](docs/PLAN.md) dan [docs/WEKNORA.md §8](docs/WEKNORA.md).** Implementasi lokal bukan izin pilot/go-live. SSO, OCR, format V1, diff/rollback, backup/restore produksi, dan persetujuan mentor/security/ops tetap di luar rilis ini. Kualitas retrieval **sudah diukur** pada corpus sintetis lewat `pnpm rag:eval`: recall@5 100% pada 20 pertanyaan answerable, abstain penuh 8/10 pada pertanyaan tanpa bukti, nol kebocoran pada 10 percobaan lintas izin, dan teks buatan model (summary yang diindeks WeKnora) tidak pernah menjadi sitasi ([§22](docs/WEKNORA.md)). Angka itu berlaku untuk fixture ini, bukan untuk dokumen nyata, dan review grounding oleh pemilik domain belum dilakukan — jadi jangan memakai jawabannya sebagai rujukan kebijakan.

## Jalankan di laptop

Prasyarat: Node **24**, pnpm **10.34.5**, Docker + Compose. RAM 8 GiB atau lebih disarankan untuk ClamAV, database, converter, dan build; ukur pada laptop target.

```sh
pnpm install --frozen-lockfile
pnpm setup:local
pnpm knowledge:start
pnpm scanner:check
pnpm knowledge:check
pnpm dev
```

Buka `http://localhost:3000`. Credential acak ada **hanya** di `var/demo-accounts.json`; jangan kirim/publikasikan file itu. Tidak ada registrasi publik, password default, provider key, atau deploy otomatis. `knowledge:start` mengunduh image/dependency dan signature, lalu menyediakan converter terisolasi; dokumen tidak dikirim ke provider.

`knowledge:start` membuat token converter acak di `.env.local` bila belum ada; **restart `pnpm dev` sesudahnya**. Scanner belum siap/signature kedaluwarsa = upload ditolak, bukan bypass. `pnpm services:stop`/`pnpm knowledge:stop` tidak menghapus volume.

### Sebelum demo: jalankan build produksi

`pnpm dev` mengompilasi setiap halaman saat pertama dibuka; di laptop yang sekaligus menjalankan WeKnora, Ollama, ClamAV, dan converter, itu terasa sebagai jeda 5–15 detik per halaman. Untuk demo pakai build produksi:

```sh
docker compose --env-file .env.local --profile weknora up -d   # postgres, WeKnora, scanner, converter
pnpm weknora:status                                            # health, hybrid search, jumlah index
pnpm build && pnpm start                                       # web + worker, mode produksi
```

Cek terakhir sebelum orang lain melihat: Ollama hidup (`curl http://localhost:11434/api/version`), `pnpm weknora:status` menyebut "Hybrid search: ok", dan satu pertanyaan pemantik di AI Assistant dijawab dengan sitasi.

**Reranker (opsional, ~571 MB unduhan sekali):** membuat asisten memilih potongan yang benar-benar menjawab dan menolak menyusun jawaban dari potongan yang hanya mirip — dengan biaya beberapa detik CPU per pertanyaan (p50 jawaban 4,5 s → 8–10 s; di VM Docker 3,8 GB matikan profil `knowledge` selama demo asisten agar VM tidak swap). Tanpa reranker, "nomor kontrak vendor yang berlaku?" dijawab dengan lokasi yang dikarang; dengan reranker, pembaca mendapat "tidak ada bagian dokumen yang menjawab secara langsung" di atas sumber terdekat. Rinciannya dan angkanya di [docs/WEKNORA.md §17](docs/WEKNORA.md).

```sh
pnpm weknora:rerank-weights                                              # unduh bobot int8 terpin ke volume
docker compose --env-file .env.local --profile weknora --profile weknora-rerank up -d
pnpm weknora:rerank                                                      # daftarkan + pin ke agen
```

## Memperbarui folder sebelumnya

Backup DB + `var/storage` menurut kebijakan Anda; jangan menghapus data. Dari folder paket baru:

```sh
node scripts/apply-update.mjs --target "PATH_FOLDER_LAMA" --check
node scripts/apply-update.mjs --target "PATH_FOLDER_LAMA" --apply
```

Updater menolak modifikasi lokal yang tidak dikenal, tidak menimpa `.env*`, `var`, atau log, serta tidak menjalankan dependency/migrasi. Hentikan app, kemudian dari folder tujuan:

```sh
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm knowledge:start
pnpm dev
```

Migrasi bersifat additive. SQL yang sudah diterapkan tidak ditulis ulang. Jangan menjalankan `db:seed` untuk mereset data yang ada.

## Deployment

Build ini tidak lagi terkunci di laptop. Profil `staging` dan `production` ada, dan
aturannya lebih ketat daripada `local-dev`: origin wajib https, cookie `Secure`, HSTS,
secret 48+ karakter, database lintas host wajib TLS, storage wajib path absolut di luar
webroot, dan akun demo menahan rilis. Konfigurasi divalidasi **saat proses start** —
salah konfigurasi keluar dengan kode 78 dan masuk crash-loop, jadi rilis sebelumnya tetap
melayani.

```sh
cp .env.production.example .env.production        # isi semua; tidak ada default
docker build -t intradocs:0.3.0 .
pnpm ops:preflight                                # gate rilis; exit 1 menahan deploy
docker compose -f compose.prod.yaml --env-file .env.production up -d
pnpm ops:bootstrap-admin --email anda@org.example --name "Nama" --unit "Divisi IT"
```

Runbook lengkap — persiapan, tiap rilis, alarm, rollback, kapasitas terukur, dan daftar
hal yang masih menjadi keputusan organisasi (SSO, TLS, kebijakan data, OCR) — ada di
[docs/DEPLOY.md](docs/DEPLOY.md).

## Operasi lokal (Q6, sebagian)

```sh
pnpm ops:ready                          # tabel kesiapan: DB, web, storage, ClamAV, converter, WeKnora, Ollama + pemilik
pnpm ops:backup                         # var/backups/<stamp>/{db.dump,storage.tar,manifest.json}; .env dan akun demo tidak ikut
pnpm ops:verify-backup var/backups/<stamp>   # restore drill ke database uji + folder sementara; tidak menyentuh yang hidup
pnpm ops:restore var/backups/<stamp> --yes   # menimpa DB dan storage lokal; app harus berhenti dulu
pnpm ops:preflight                          # gate rilis: konfigurasi, migrasi, akun demo, backup terverifikasi
pnpm ops:watch --interval 30 --grace 3      # alarm: satu baris per perubahan status, exit 1 saat down berulang
pnpm ops:rollback-check v0.2.0              # apakah rollback kode saja aman, atau butuh restore database
pnpm ops:loadtest --users 4 --seconds 20    # kapasitas terukur; exit 1 bila p95 melewati anggaran
```

WeKnora tidak ikut di-backup: indeksnya turunan dari `app.rag_index_entries` + Markdown kanonik dan dibangun ulang oleh `pnpm weknora:sync`. Rollback rilis = checkout tag sebelumnya + `pnpm build`; migrasi hanya maju, jadi rollback skema berarti restore dari backup sebelum migrasi itu.

## Demo alur lengkap

1. Contributor unggah berkas sintetis dan lampiran ke kategori leaf yang diizinkan. Maksimal **50 MiB/berkas, 100 MiB total**, canonical gabungan **2 MiB**.
2. Periksa canonical, original, dan locator di reader. Gunakan klasifikasi minimal kategori. Terbatas/Rahasia memerlukan grant eksplisit; bahkan Super Admin tidak punya akses menyeluruh.
3. Untuk kategori/label Kritikal atau dokumen sensitif, pilih **dua reviewer** berbeda dalam scope. Berikan grant sensitif melalui panel pemilik sebelum memilih reviewer. Viewer tetap tidak dapat membaca data sensitif.
4. Reviewer pertama dan kedua meninjau versi yang sama. Minta revisi/tolak wajib beralasan. Credential palsu/pola PII memerlukan justifikasi; private key harus dihapus lewat versi baru.
5. Sesudah persetujuan final, worker membangun indeks. Pembaca baru melihat versi setelah `ready/published`; versi aktif lama tetap tersedia bila revisi sedang diproses atau gagal.
6. Cari kata di dalam isi; filter metadata, simpan favorit, beri feedback. Revisi, pencabutan, expiry, dan perubahan scope/grant berlaku pada query berikutnya termasuk download.

## SSO lewat OpenID Connect

`AUTH_MODE=oidc` menambahkan tombol "Masuk dengan <IdP>" untuk akun yang sudah diundang;
SSO tidak pernah membuat akun. Untuk mencobanya di laptop: `pnpm idp:mock` (IdP tiruan di
`http://localhost:3099`, memilih nama = "masuk"), lalu di `.env.local` set `AUTH_MODE=oidc`,
`OIDC_ISSUER=http://localhost:3099`, `OIDC_CLIENT_ID=intradocs-local`,
`OIDC_CLIENT_SECRET=mock-idp-secret-not-for-deployments`. Detail deployment di
[docs/DEPLOY.md](docs/DEPLOY.md) §2a.

## Ekspor audit log

Audit Log bisa disaring per rentang tanggal dan aktivitas, lalu diekspor sebagai CSV atau
JSON Lines (maksimal setahun, 50.000 baris, trailer menyebut jumlah baris). Cakupan dan
penyamaran nama sama dengan halamannya; ekspor itu sendiri tercatat sebagai event
`audit.exported`. Rincian di [docs/DEPLOY.md](docs/DEPLOY.md) §2d.

## Retensi otomatis

Worker menjalankan kebijakan tiap jam: dokumen yang kedaluwarsa dan tidak diperbarui dalam
masa tenggang diarsipkan dengan alasan tercatat, review yang terlewat lama dieskalasi ke
admin kategori, dan pemilik bisa mengonfirmasi "masih berlaku" dari halaman dokumen tanpa
mengunggah versi baru. Jendelanya `RETENTION_GRACE_DAYS` / `RETENTION_OVERDUE_DAYS` (default
30). Rincian di [docs/DEPLOY.md](docs/DEPLOY.md) §2c.

## Email pemberitahuan

Isi lonceng juga bisa dikirim ke kotak masuk sebagai ringkasan per orang (`MAIL_MODE=smtp`
dengan relay organisasi, lihat [docs/DEPLOY.md](docs/DEPLOY.md) §2b). Di laptop,
`MAIL_MODE=file` plus `MAIL_FROM=IntraDocs <noreply@intradocs.example.test>` di `.env.local`
menulis setiap email ke `var/outbox/*.eml`. Setiap orang punya sakelar sendiri di Pengaturan.

## Isi demo yang lebih penuh

`pnpm demo:content` mengisi portal lewat aplikasi sendiri (unggah → scan → konversi →
review → publikasi, dengan RLS dan jejak audit sungguhan) sehingga tidak ada halaman yang
kosong saat demo: 18 dokumen sintetis di keenam kategori dan enam format (MD, TXT, HTML,
DOCX, XLSX, PDF), item di antrean Andi, Dwi, dan Budi, satu permintaan revisi, satu
penolakan, satu draf belum diajukan, masukan pembaca untuk pemilik, dua permintaan akses
menunggu keputusan, bacaan wajib bertenggat, favorit dan riwayat baca Siti, serta beberapa
percakapan asisten. Aman dijalankan ulang (judul yang sudah ada dilewati); `--no-ai`
melewati percakapan asisten.

## Demo AI Assistant dan fitur V1 (butuh profil `weknora`)

Jalankan `pnpm weknora:setup` sekali, isi `AI_PROVIDER=weknora-local` (dan `AI_GENERATION=weknora-local` bila ingin jawaban tersusun, bukan hanya sumber; pin model penjawab dengan `pnpm weknora:generation <model>`), lalu restart `pnpm dev`. Pada laptop 8 GB tanpa GPU matikan profil `knowledge` (ClamAV/converter) selama demo AI; pada laptop ber-GPU keduanya berjalan bersama.

Akun demo ada di `var/demo-accounts.json` (siti = viewer Infrastruktur+Data; fajar = viewer SOP saja; rizky = contributor; dwi = reviewer Keamanan; andi = admin knowledge; budi = super admin).

1. **Alur inti, satu tarikan napas** — rizky unggah Markdown sintetis (`/unggah`): "Bantuan metadata" menandai dokumen terbit yang mirip dan label yang disebut teks tanpa mengirim draft ke mana pun → simpan draft → ajukan review ke andi → andi setujui → worker publikasi dan indeks (±15 detik) → siapa pun dengan scope bertanya ke asisten dan mendapat jawaban **bersitasi ke dokumen yang baru saja terbit**.
2. **AI Assistant** sebagai siti: sapa dulu ("halo", "kamu bisa apa?", "apa ada dokumen lain yang menarik?") — dijawab tanpa model, dari daftar dokumen yang boleh ia baca. Lalu ketik "Apakah MFA wajib untuk VPN lab?" di kotak **Tanya AI** beranda — pertanyaan langsung terkirim ke asisten → jawaban dengan kutipan yang bisa dibuka ke bagian dokumen, dan chip pertanyaan lanjutan di bawahnya. Lanjutkan di utas yang sama: "Jelaskan lebih lengkap" → uraian langkah konfigurasi dari sumber yang sama; "Kalau perangkat authenticator-nya hilang?" → tiga langkah dari bagian "Jika perangkat authenticator hilang" yang baru ada di **v1.1** (revisi rizky yang disetujui andi — sebelum revisi itu terbit asisten menjawab "tidak ada bagian dokumen yang menjawab", jadi ini juga bukti bahwa yang dikutip selalu versi terbit terbaru); "Dan kalau koneksinya gagal setelah itu?" → langkah persis dari bagian "Jika koneksi gagal" — pertanyaan lanjutan dipahami dari riwayat ([docs/WEKNORA.md §24](docs/WEKNORA.md)). Di halaman dokumen VPN, **Bandingkan versi** menampilkan diff v1.0 → v1.1 baris demi baris. "harga saham" → "tidak tahu" tanpa memanggil model; injeksi "abaikan aturan akses" → tetap "tidak tahu". Ubah **ruang lingkup** ke satu kategori atau ke "dokumen yang saya buka"; riwayat percakapan tersimpan hanya untuk pemiliknya. Nilai jawaban "Membantu / tidak".
3. **Pencarian** (`/search`): pertanyaan bahasa alami yang lexical-nya nol hasil tetap mendapat "Sumber yang relevan menurut AI" di atasnya, dengan tautan lanjut ke asisten.
4. Ulangi pertanyaan VPN sebagai **fajar**: cakupan 1 versi, abstain — scope kategori berlaku pada retrieval, bukan hanya pada halaman.
5. **Cabut** dokumen VPN sebagai pemiliknya, lalu buka riwayat percakapan siti: sitasi ke dokumen itu hilang dan jawabannya ikut disembunyikan; tanya lagi → tidak dikutip.
6. **Halaman dokumen**: "Tanya asisten tentang dokumen ini" (pertanyaan yang dihasilkan model dari dokumen); bagi yang boleh merevisi: draf ringkasan model dan saran label, keduanya hanya masuk ke form revisi lewat tombol dan tetap direview.
7. **Kategori & Label** (andi): saran perapian (label mirip / tidak terpakai), urutan lewat seret atau ↑/↓, ekspor taksonomi, panel aturan yang berlaku.
8. **Pengguna & RBAC** (budi): "Undang Pengguna" → tautan sekali pakai tampil satu kali → buka di jendela privat, tetapkan password, masuk sebagai akun baru dengan scope yang diputuskan admin. **Role kustom**: "+ Role kustom baru" → mis. _Penulis SOP_ = Reviewer tanpa "Review & persetujuan" → tugaskan ke dwi lewat "Edit penugasan" → dwi melihat nama role barunya di topbar, menu Antrean Persetujuan hilang, dan `/admin/approval` menolak — tanpa login ulang; role kustom hanya mempersempit role dasarnya, tidak pernah menambah ([docs/UI.md U14](docs/UI.md)).
9. **Dashboard** (andi/budi): ubin AI (pertanyaan, abstain, kutipan ditolak, dinilai membantu) dari jejak audit tanpa satu pun teks; knowledge gap termasuk pertanyaan asisten yang tak terjawab, dengan "Jawab sebagai dokumen". **Audit Log** membaca aktivitas dalam bahasa manusia.

Ingin mencoba wiki dan chat bawaan WeKnora pada corpus yang sama? `pnpm weknora:lab` membuat knowledge base terpisah dengan semuanya menyala dan membuka UI WeKnora ke sana tanpa menyentuh yang dibaca portal — lihat [docs/WEKNORA.md §15](docs/WEKNORA.md).

Yang sengaja **tidak** ada di portal dan alasannya ada di [docs/WEKNORA.md](docs/WEKNORA.md): wiki/Langfuse/unggah ke WeKnora (rekaman tanpa versi IntraDocs tidak bisa dikutip), UI WeKnora sebagai permukaan pengguna (tidak mengenal klasifikasi, scope, grant), dan teks buatan model sebagai sitasi (chunk `summary` ditolak gerbang, §22).

## Konversi yang jujur

- MD: UTF-8, normalisasi BOM/newline; renderer sanitasi HTML/URL. TXT: literal fenced text.
- PDF: teks ber-layout + locator halaman; tidak mengarang urutan baca lintas kolom. File pindai/tanpa teks, encrypted, attachment/script aktif, atau rusak ditolak.
- DOCX: heading, paragraf, nomor daftar dasar, tabel biasa, Unicode; locator paragraf/tabel, **bukan halaman palsu**. Struktur kompleks, gambar yang membutuhkan OCR, sel gabungan, atau penomoran tak didukung ditolak.
- XLSX: nilai/cache yang sudah tersimpan + koordinat sheet/cell; format angka ditampilkan bila relevan. Formula tanpa cache ditolak; tidak menjalankan formula/macro/link eksternal.
- Satu sheet maksimal 2.000 baris × 50 kolom; maksimal 20 sheet. ZIP internal dibatasi rasio/ukuran/jumlah entry; parsing dalam subprocess ber-timeout dan batas RAM/CPU.

Pemilik/reviewer tetap wajib membandingkan sumber. Precheck pola adalah perlindungan terbatas, bukan sertifikasi DLP/ISO.

## Pengujian

```sh
pnpm check                  # lint + strict types + unit + content + build
pnpm test:python            # jalankan dari venv Python di bawah
pnpm test:integration       # PostgreSQL/RLS nyata; dataset sintetis
pnpm test:http              # app + worker + ClamAV + converter harus berjalan
pnpm test:e2e               # browser; install Chromium Playwright bila diperlukan
pnpm verify:local           # gate bertahap, laporan PASS/FAIL/BLOCKED yang jujur
pnpm storage:gc             # dry-run; tidak menghapus secara default
```

Untuk tes native (tanpa menjalankan Python di container), siapkan venv agar parser `python -I` tetap menemukan dependency. Aktivasi venv mengikuti OS Anda:

```sh
python -m venv .venv
# Linux/macOS: source .venv/bin/activate
# Windows PowerShell: .venv\Scripts\Activate.ps1
python -m pip install -r apps/knowledge-runtime/requirements-test.txt
pnpm test:python
```

`python -I` sengaja mengabaikan user-site. Jangan melepas isolasi sebagai solusi dependency. Boot Compose belum dibuktikan pada sandbox; lihat batas dan bukti native pada PLAN.

Jangan menjalankan suite mutasi secara paralel pada database yang sama. Hindari build/typecheck bersamaan dengan dev compiler di mesin kecil. `pnpm build` lalu `pnpm start` menguji bundle produksi secara lokal, **bukan deployment produksi**.

Fixture kecil yang disertakan benar-benar sintetis. `scripts/generate-conversion-fixtures.py` meregenerasi fixture menggunakan dependency test `reportlab` dan `python-docx`; workbook memiliki tipe numerik dan koordinat yang dapat diaudit. File invalid adalah rejection fixture yang disengaja.

## Peta proyek

- `apps/web`: portal Next.js, reader aman, UI dan HTTP boundary.
- `apps/worker`: pg-boss reminder + durable outbox publisher; tidak bisa SELECT dokumen/auth.
- `apps/knowledge-runtime`: converter Python non-root, read-only, jaringan Compose internal, tanpa provider.
- `packages/core`: validasi, state machine, file/storage/scanner, chunking.
- `packages/db`: DAL transaksi actor-local, SQL/RLS dan fixed security-definer functions.
- `tests`: unit, renderer, PostgreSQL, HTTP end-to-end, Python, Playwright.
- `docs`: PRD/arsitektur/UI/plan; `reference`: mockup mentor asli.

Lanjutkan dari README dan **§0 docs/PLAN.md**, bukan status historis pada artefak lama. Jangan sertakan `.env*`, `var`, `node_modules`, `.next`, session, atau data organisasi ketika membagikan source.
