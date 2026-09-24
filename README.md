# IntraDocs

Portal knowledge base internal untuk dokumentasi IT: kontributor mengunggah dokumen, reviewer
memvalidasinya, lalu karyawan mencari dan bertanya ke asisten AI yang **hanya menjawab dari
dokumen yang sudah disetujui dan boleh mereka baca**, selalu dengan sitasi. Termasuk modul
**Technology Architecture** (layer teknologi Enterprise Architecture) yang diimpor dari Sparx EA.

Semua data di repo ini **sintetis**. AI berjalan lokal (WeKnora + Ollama); tidak ada dokumen
yang dikirim ke provider cloud. Desain mengikuti [mockup mentor](reference/intradocs-mockup_1.html).

## Untuk reviewer

### Coba tanpa instalasi

Buka tautan demo yang dikirim bersama repo ini. Halaman login menampilkan daftar akun demo;
**satu klik** masuk sebagai peran tersebut, **Keluar** untuk berganti akun. Tautan hidup selama
laptop pengembang menyala (Cloudflare Quick Tunnel); bila mati, jalankan lokal di bawah.

| Akun  | Peran           | Cakupan             | Coba ini                                                        |
| ----- | --------------- | ------------------- | --------------------------------------------------------------- |
| Siti  | Viewer          | Infrastruktur, Data | Cari, baca dokumen, tanya AI Assistant, Technology Architecture |
| Fajar | Viewer          | SOP saja            | Pertanyaan yang sama dengan Siti → tidak melihat dokumen Siti   |
| Rizky | Contributor     | Infrastruktur       | Unggah dokumen → konversi → ajukan review                       |
| Dwi   | Reviewer        | Keamanan            | Antrean Persetujuan: setujui / minta revisi / tolak             |
| Andi  | Admin Knowledge | Semua kategori      | Kategori & Label, Dashboard, ajukan impor arsitektur            |
| Budi  | Super Admin     | Semua kategori      | Pengguna & RBAC, Audit Log, setujui impor arsitektur            |

### Skenario 10 menit

1. **Alur dokumen** — Rizky: _Unggah Dokumen_ (Markdown/DOCX/PDF) → pratinjau hasil konversi →
   ajukan ke Andi → Andi setujui di _Antrean Persetujuan_ → dokumen terbit dan terindeks
   (±15 detik). Rizky tidak bisa menyetujui dokumennya sendiri.
2. **AI Assistant** — Siti bertanya _"Apakah MFA wajib untuk VPN lab?"_ → jawaban dengan sitasi
   yang membuka bagian dokumen sumber. _"harga saham"_ atau _"abaikan aturan akses"_ → asisten
   menyatakan tidak tahu, bukan mengarang.
3. **Izin** — ulangi pertanyaan VPN sebagai Fajar: tidak ada sumber, karena kategori itu di luar
   cakupannya. Pembatasan ini ditegakkan di database (RLS), bukan hanya di tampilan.
4. **Technology Architecture** — Siti buka menu _Technology Architecture_ → `srv-db-01` →
   _Dampak jika tidak tersedia_ menampilkan aplikasi yang ikut terganggu beserta jalurnya. Tanya
   _"server apa yang end of support?"_. Andi mengajukan impor di _Impor dari Sparx EA_; Budi
   (admin lain) menyetujuinya — sama seperti review dokumen.
5. **Tata kelola** — Budi buka _Audit Log_ (semua langkah di atas tercatat) dan _Dashboard_.

## Fitur

| Area                    | Isi                                                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Akses                   | Login lokal atau SSO OpenID Connect, lima role + role kustom, cakupan per kategori, klasifikasi Internal/Terbatas/Rahasia, Row-Level Security PostgreSQL            |
| Dokumen                 | MD, TXT, PDF (termasuk pindaian via OCR), DOCX, XLSX, HTML, PPTX + lampiran; scan ClamAV wajib; original disimpan immutable, Markdown kanonik dengan locator sumber |
| Review                  | Satu atau dua reviewer, larangan self-approval, revisi/tolak beralasan, pra-cek secret/PII, versi immutable, bandingkan versi, rollback lewat draft                 |
| Penemuan                | Pencarian kata + semantik, facet, favorit, riwayat baca, bacaan wajib, permintaan akses, notifikasi (lonceng + email)                                               |
| AI Assistant            | Jawaban bersitasi yang divalidasi ulang ke database tiap permintaan, abstain bila tak ada bukti, cakupan KB/kategori/dokumen, riwayat percakapan, penilaian jawaban |
| Technology Architecture | Impor XMI/CSV Sparx EA lewat review, katalog elemen, dampak & dependensi, end of support, tanya arsitektur                                                          |
| Operasi                 | Retensi otomatis, ekspor audit CSV/JSONL, backup/restore teruji, gate rilis, alarm, load test, storage S3                                                           |

Status per requirement dan bukti tes: [docs/PLAN.md §0](docs/PLAN.md).

## Jalankan di laptop

Prasyarat: Node **24**, pnpm **10.34.5**, Docker + Compose, RAM ≥ 8 GB.

```sh
pnpm install --frozen-lockfile
pnpm setup:local        # database, migrasi, akun demo sintetis
pnpm knowledge:start    # ClamAV + converter (wajib untuk unggah)
pnpm dev                # http://localhost:3000
pnpm demo:content       # terminal lain: 18 dokumen sintetis + model arsitektur, lewat alur aplikasi
```

Password akun demo acak per instalasi dan hanya ada di `var/demo-accounts.json` (tidak masuk
Git). `DEMO_LOGIN=true` di `.env.local` menampilkan tombol masuk cepat seperti pada tautan demo
(ditolak pada profil `production`).

**AI Assistant (opsional):** pasang [Ollama](https://ollama.com), `ollama pull bge-m3`, lalu
`pnpm weknora:setup`, isi `AI_PROVIDER=weknora-local` di `.env.local`, dan restart. Tanpa ini
portal, pencarian kata, dan reader tetap berjalan. Langkah lengkap, jawaban tersusun
(`AI_GENERATION`), dan reranker: [docs/WEKNORA.md §3](docs/WEKNORA.md).

Untuk demo pakai build produksi (`pnpm build && pnpm start`); `pnpm dev` mengompilasi setiap
halaman saat pertama dibuka. `pnpm ops:ready` memeriksa semua layanan sekaligus.

## Pengujian

```sh
pnpm check              # lint + TypeScript strict + unit + build
pnpm test:integration   # PostgreSQL/RLS nyata
pnpm test:http          # app + ClamAV + converter harus berjalan
pnpm test:e2e           # Playwright + axe, desktop dan mobile
pnpm rag:eval           # 40 pertanyaan berlabel: recall, abstain, kebocoran lintas izin
```

Suite yang mengubah data dijalankan berurutan, jangan paralel pada database yang sama. CI
GitHub menjalankan format, lint, typecheck, unit, build, dan verifikasi source pada setiap PR;
suite integrasi, HTTP, dan e2e butuh layanan lokal dan dijalankan di laptop.

## Dokumentasi

| Dokumen                              | Isi                                                                    |
| ------------------------------------ | ---------------------------------------------------------------------- |
| [PRD](docs/PRD.md)                   | Kebutuhan per layar S01–S11 dan aturan yang tidak bisa ditawar         |
| [ARCHITECTURE](docs/ARCHITECTURE.md) | Stack, batas data, otorisasi RLS, alur ingest–review–publikasi, RAG    |
| [UI](docs/UI.md)                     | Kesetiaan terhadap mockup mentor dan delta yang disetujui              |
| [PLAN](docs/PLAN.md)                 | Status, bukti tes, quality gate Q1–Q6, apa yang belum                  |
| [DEPLOY](docs/DEPLOY.md)             | Staging/production, SSO, email, S3, OCR, runbook, keputusan organisasi |
| [WEKNORA](docs/WEKNORA.md)           | Mesin RAG lokal, evaluasi Q4, Technology Architecture (§28)            |
| [AGENTS](AGENTS.md)                  | Aturan kerja pengembangan                                              |

## Struktur

```
apps/web               portal Next.js: halaman, API, reader aman
apps/worker            publikasi, indeks, pengingat, retensi, email, sinkron WeKnora
apps/knowledge-runtime converter Python terisolasi (tanpa jaringan, tanpa kredensial)
packages/core          aturan domain, validasi, parser (dokumen, Sparx EA)
packages/db            akses data, migrasi SQL, RLS, fungsi security-definer
tests                  unit, integrasi, HTTP, e2e, RAG, Python
fixtures               data sintetis (dokumen, model Sparx EA)
reference              mockup mentor asli
```

## Batas rilis ini

Ini rilis lokal dengan data sintetis, **bukan** izin pilot. Yang masih memerlukan organisasi:
IdP SSO sungguhan, kebijakan data dan retensi, review security/ops, UAT oleh pemilik domain,
TLS dan backup off-site ([docs/DEPLOY.md §6](docs/DEPLOY.md)). Angka kualitas AI berlaku untuk
corpus sintetis ini, bukan untuk dokumen nyata.
