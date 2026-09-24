# Arsitektur — sederhana pada operasi, ketat pada batas data

Dokumen ini menjelaskan arsitektur yang **berjalan di source saat ini**. Status dan bukti tes ada
di [PLAN.md §0](PLAN.md); rincian RAG di [WEKNORA.md](WEKNORA.md); deployment di
[DEPLOY.md](DEPLOY.md). Tidak ada klaim benchmark produksi atau sertifikasi keamanan.

## 1. Stack

| Lapisan        | Dipakai                                                                                          | Alasan / batas                                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Web + API      | Next.js 16 App Router, React 19, TypeScript strict, Node.js 24                                   | Satu backend bisnis untuk portal, admin, dan API; reader dirender di server.                                                       |
| UI             | CSS variables dari mockup mentor (`apps/web/src/app/*.css`), ikon SVG sendiri                    | Kesetiaan pada mockup lebih mudah tanpa tema komponen generik. Markdown lewat remark/rehype dengan sanitasi; MDX tidak dieksekusi. |
| Data           | PostgreSQL 17 dengan Row-Level Security, full-text search; Drizzle + 45 migrasi SQL additive     | Metadata, izin, workflow, pencarian kata, dan queue di satu sistem. Migrasi yang sudah diterapkan tidak pernah diubah.             |
| Identitas      | Better Auth: email/password lokal, OpenID Connect untuk IdP organisasi; sesi di database         | Login nyata sejak lokal; SSO tidak pernah membuat akun baru (harus diundang).                                                      |
| Berkas         | Filesystem privat di luar webroot, atau S3-compatible (SigV4 sendiri, tanpa SDK)                 | Original, Markdown kanonik, provenance, dan lampiran immutable (`If-None-Match: *`, checksum).                                     |
| Background     | Worker Node + pg-boss + transactional outbox                                                     | Publikasi, indeks, pengingat, retensi, email, sinkron WeKnora; retry idempoten tanpa Redis/Celery.                                 |
| Konversi       | Python 3.13 terisolasi: pypdf, openpyxl, defusedxml, Tesseract OCR (ind+eng)                     | Non-root, read-only, tanpa jaringan dan kredensial; hanya dipanggil worker/web dengan token.                                       |
| Pemindai       | ClamAV 1.4.6                                                                                     | Wajib untuk setiap original dan lampiran; scanner mati = unggah ditolak, bukan dilewati.                                           |
| RAG (opsional) | [WeKnora](https://github.com/Tencent/WeKnora) lokal + Ollama (`bge-m3`; model penjawab opsional) | Chunking, embedding, hybrid search. Tidak pernah memutuskan izin. Default off; tanpa GPU dan tanpa provider cloud.                 |
| QA             | `node:test`, Playwright + axe, Python unittest; CI GitHub                                        | Versi dependency dipin; lockfile dipertahankan.                                                                                    |

**Profil.** `APP_PROFILE=local-dev` (loopback, akun demo), `staging` dan `production` (https wajib,
cookie Secure, HSTS, secret ≥48 karakter, TLS database lintas host, akun demo menahan rilis).
Konfigurasi divalidasi saat start; salah konfigurasi keluar dengan kode 78. Docker Compose untuk
pengembangan/pilot VM tidak diklaim high availability.

## 2. Batas modul dan data

Satu repository: `apps/web`, `apps/worker`, `apps/knowledge-runtime` (converter Python); `packages/core` untuk aturan/domain/validasi bersama; `packages/db` untuk query/migrasi. `tests` berisi fixtures, integration, e2e dan evaluasi RAG. Jangan memecah setiap tabel menjadi service/package.

Modular berarti batas tanggung jawab, bukan banyak microservices: auth/identity, documents, approval, taxonomy, search, chat dan audit tetap dalam satu backend bisnis. Adapter hanya pada batas yang benar-benar berubah: **identity provider, storage, mesin RAG**. Queue tetap pg-boss; tidak membangun universal queue/plugin framework. Provider dipilih server-side dan allowlisted, tidak dari URL kiriman user. Ganti storage perlu copy+verifikasi checksum; ganti model embedding perlu staging reindex dan atomic cutover, bukan sekadar mengganti environment variable pada indeks lama.

| Kelompok entitas                             | Isi/invariant utama                                                                                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Users, sessions, groups, memberships         | Identitas stabil `(issuer, subject)`, status aktif, unit, waktu sync; schema sesi mengikuti library auth.                                              |
| Roles, permissions, assignments              | Capability × cakupan kategori/unit; grants sensitif eksplisit; versi kebijakan untuk invalidasi.                                                       |
| Categories, labels, document_labels          | Category parent + urutan; maksimum tiga tingkat, tanpa cycle; dokumen menyimpan satu leaf category.                                                    |
| Documents                                    | ID stabil, slug, owner user/group, kategori, klasifikasi, active published-version pointer, withdrawn flag.                                            |
| Document_versions, assets                    | MD/source/provenance key, checksum, version number, revision hash, tanggal berlaku/review/expiry, manifest lampiran. Versi yang diajukan dibekukan.    |
| Approval_requests, steps, findings, comments | Versi/hash yang disetujui, aturan saat submit, approver/timestamp/keputusan/alasan; temuan keamanan dan penyelesaiannya.                               |
| Search index, rag_index_entries              | Teks+heading+locator per versi terbit untuk pencarian kata; pemetaan versi ↔ record WeKnora. Turunan yang dapat dibangun ulang, staging tidak terbaca. |
| Conversations, messages, citations           | Owner, daftar sumber/versi yang menjadi dependensi, klasifikasi turunan, status; tidak dibagikan publik.                                               |
| Favorites, feedback, notifications, events   | Preferensi pribadi, antrean koreksi, unread notification, aktivitas minimal untuk dashboard.                                                           |
| Audit_events, outbox, jobs                   | Actor/action/object/version/time/request ID; append-only untuk aplikasi; pengiriman ulang harus idempotent.                                            |
| ta_elements, ta_relations, ta_imports        | Model Technology Architecture per kategori; impor = change set yang direview (empat mata), riwayat perubahan per field; lihat WEKNORA.md §28.          |

DB menentukan izin dan status, bukan frontmatter dari file upload. MD canonical disimpan sebagai object immutable, bukan hanya teks embedding: `documents/{id}/versions/{version}/content.md`, `provenance.json`, original dan aset. Chunk/search index adalah turunan yang dapat dibangun ulang. SHA-256 dan manifest mengikat semua artefak versi.

Kontrak API cukup berupa route handlers tervalidasi: upload/start+finalize+status; dokumen/list/detail/versions/download; submit/decision; search; conversations/messages; admin users/taxonomy/audit. Identitas dari sesi server, bukan `userId` kiriman client. Semua input/hasil dibatasi schema; pagination/filter allowlist, parameterized SQL, batas payload, correlation ID; conflict revisi memakai optimistic version/If-Match dan mengembalikan 409.

## 3. Otorisasi: server dan database

### Login sekarang, SSO kemudian tanpa rewrite

Lokal memakai email/password Better Auth dengan hash bawaan library dan session DB. Tidak ada sign-up publik; seed akun sintetis untuk lima role, credential acak per instalasi, bukan password hardcoded atau tombol ganti-role. Reset development melalui CLI lokal; tidak perlu SMTP/SMS. API tetap menegakkan RBAC. `local-dev` bind loopback; jangan mengekspos DB/storage lewat LAN secara default.

Siapkan `AuthIdentity` dengan internal user ID stabil dan external identity `(issuer, subject)`. Mode `oidc` ditargetkan untuk IdP organisasi, misalnya Entra ID **jika memang tersedia**, bukan asumsi Telkom memakainya. Jika hanya AD/LDAP/SAML, gunakan bridge organisasi; Keycloak baru hanya jika benar-benar diperlukan, tidak dipasang demi demo. Login SSO tidak perlu dibeli/dibangun dari nol.

Saat migrasi, account linking dilakukan melalui prosedur admin terverifikasi; jangan otomatis menggabungkan akun hanya karena email sama. Untuk profil `production`, akun demo, seed, dan `DEMO_LOGIN` ditolak saat start; OIDC, MFA IdP, mapping grup dan offboarding diuji nyata. `NODE_ENV=production` tidak cukup menentukan keamanan: gunakan profil eksplisit `local-dev`/`staging`/`production`, agar production build lokal tetap bisa diuji tanpa membuka mode demo pada produksi perusahaan.

Prasyarat setiap operasi: sesi sah, akun aktif, capability ada, scope cocok, klasifikasi diizinkan, status versi sesuai tindakan. **Deny by default.** “Publik” pada pilot tetap berarti konten portal berautentikasi; bukan anonymous internet publishing.

| Kemampuan                | Super Admin      | Admin Knowledge                           | Reviewer                       | Contributor                          | Viewer                 |
| ------------------------ | ---------------- | ----------------------------------------- | ------------------------------ | ------------------------------------ | ---------------------- |
| Baca Internal/Publik, AI | Sesuai scope     | Sesuai scope                              | Sesuai scope                   | Sesuai scope                         | Sesuai scope           |
| Baca Terbatas/Rahasia    | Grant eksplisit  | Grant eksplisit                           | Grant eksplisit                | Grant eksplisit                      | Tidak pada role bawaan |
| Unggah/edit              | Scope + hak edit | Scope + hak edit                          | Scope + hak edit               | Milik sendiri/kolaborasi dalam scope | Tidak                  |
| Approve/reject           | Ditugaskan       | Ditugaskan                                | Ditugaskan dalam scope         | Tidak                                | Tidak                  |
| Taksonomi                | Global           | Scope yang dikelola                       | Tidak                          | Tidak                                | Tidak                  |
| Pengguna/role            | Kelola           | Penugasan role non-admin dalam scope saja | Tidak                          | Tidak                                | Tidak                  |
| Audit/analitik           | Scope berwenang  | Scope berwenang                           | Aktivitas review/scope sendiri | Tidak                                | Tidak                  |

Hak edit tidak otomatis membuka semua draft orang lain. Grant sensitif membutuhkan persetujuan pemilik berwenang; jangan mempromosikan Viewer menjadi Contributor sekadar agar bisa membaca. Role kustom hanya mempersempit role dasarnya, tidak pernah menambah hak. Admin tidak boleh mengeskalasi diri atau menjadi dua approver atas versi sendiri. Ini penguatan sengaja terhadap contoh matriks mentor.

- DAL `server-only` menjadi satu pintu query/otorisasi. Route protection/proxy hanya UX, bukan kontrol terakhir. RLS melindungi dokumen, versi, chunk, pesan dan metadata terkait; uji join/aggregate juga.
- Role DB aplikasi bukan owner/superuser dan tanpa BYPASSRLS; migration role terpisah. Aktifkan/FORCE RLS pada tabel terlindungi. Konteks actor dari sesi dipasang transaction-local; test pool reuse agar identitas tidak tertukar. Worker punya izin service terbatas, bukan bypass untuk endpoint user.
- ACL dan status difilter **di SQL sebelum hasil keluar ke aplikasi/model** pada lexical maupun vector query. HNSW boleh memindai kandidat internal database sebelum filter, tetapi tidak boleh ada teks kandidat tak berizin dalam respons/DAL context.
- Grant kategori diwariskan ke descendant; restrictive classification floor menang. Pemindahan kategori/perluasan akses memerlukan preview dampak dan persetujuan berwenang. Pengetatan izin berlaku segera, tidak menunggu reindex atau job malam.
- Periksa izin pada original, MD, gambar, citation, ekspor, counts, autocomplete, rekomendasi dan kemiripan. Gunakan download handler terautentikasi yang mem-proxy private file/object; Jangan gunakan URL baca presigned panjang umur. Upload presigned hanya menuju staging sementara, tidak dapat menimpa versi yang telah disetujui.
- Session cookie HttpOnly/Secure/SameSite, CSRF/origin validation, CSP, TLS; OIDC state/nonce/PKCE dan validasi issuer/audience. Mapping role dari grup IdP terverifikasi/allowlist; jangan dari email/domain atau input profil semata.
- Offboarding membutuhkan event/SCIM/sync IdP yang nyata; OIDC sendiri tidak memberi jaminan langsung. Target awal ≤5 menit setelah sumber direktori memberi perubahan, dengan TTL/fail-closed untuk data sensitif bila sync stale; wajib dibuktikan sebelum pilot organisasi, bukan syarat memulai M0 lokal. Revoke session lokal dan naikkan policy version.
- Recheck hak sumber saat histori chat dibuka, pesan lanjutan dikirim, ekspor, dan sebelum jawaban dilepas. Jika dependensi tidak lagi boleh dibaca, blokir seluruh percakapan terkait dengan pesan netral dan jangan gunakan ringkasannya sebagai konteks. Data yang sudah diunduh sebelumnya tidak bisa ditarik kembali secara ajaib.

## 4. Ingestion, approval, publication

Unggah melewati: auth/scope → admission lease → scan ClamAV atas bytes yang sama → konversi di
runtime terisolasi → original + Markdown + provenance immutable → transaksi draft + audit.
Frontmatter berkas bukan metadata otoritatif. Lease 90 detik, satu aktif per akun, duplikat
dideteksi per pemilik tanpa membocorkan judul di luar izin. Garbage collection storage default
dry-run (`pnpm storage:gc`), minimal 24 jam, mem-pin semua referensi.

1. **Staging:** bind upload ke user/kategori; batas 50 MB/file, quota batch; validasi ekstensi, MIME, magic bytes, ukuran setelah dekompresi. Nama object dibuat sistem. Scan malware sebelum parsing. Hash mendeteksi duplikat; jangan mengungkap judul dokumen duplikat di luar izin.
2. **Konversi:** converter menerima bytes, bukan URL bebas; remote resources, macro, script dan external links tidak dieksekusi. MD/TXT dinormalisasi deterministik; PDF berteks per halaman (pindaian lewat OCR, ditandai); DOCX lewat XML aman; HTML disanitasi; PPTX lewat parser WeKnora bila aktif; XLSX menjaga nama sheet, header, row/cell range dan cached values—tidak menjalankan formula. Nilai cache yang hilang ditandai, bukan dihitung/ditebak.
3. **Artefak:** simpan original, MD, gambar yang aman, provenance. PDF memakai halaman dan bila tersedia bounding box; DOCX/MD/TXT memakai heading/paragraph/line, XLSX sheet+range. Nomor halaman DOCX yang tidak stabil tidak boleh dikarang. Hasil yang kehilangan tabel/angka penting ditahan untuk koreksi.
4. **Preview & checks:** contributor membandingkan MD dengan original. Temuan secret/PII muncul sebelum bantuan LLM; secret nyata harus dihapus melalui versi baru, false positive memerlukan justifikasi reviewer berwenang. Scanner bukan bukti isi pasti aman. Metadata AI opsional V1 hanya saran; gagal AI tidak menghalangi pengisian manual.
5. **Submit:** bekukan content hash, metadata, klasifikasi, lampiran dan aturan review. Default satu tahap; Kritikal/Terbatas/Rahasia atau aturan kategori dua tahap. Dua actor berbeda, bukan author; tiap actor harus berizin atas isi. Perubahan sesudah submit membatalkan review lama dan mengulang tahap.
6. **Publish:** keputusan terakhir menulis state approved + outbox secara atomik. Worker membangun indeks staging **sesudah** approval. Verifikasi expected hash, jumlah chunk dan model version; transaksi terakhir menukar active-version pointer. Versi lama tetap aktif sampai swap, kecuali sudah expired/withdrawn. Job basi tidak boleh menerbitkan versi yang dicabut.
7. **Recovery:** unique job key `(version, step, pipeline_revision)`, retry terbatas dengan backoff, dead-letter/manual retry; crash dapat menyebabkan pengiriman ulang sehingga setiap side effect idempotent. Upload parsial, file orphan dan staging dibersihkan berdasarkan kebijakan retensi.

Pisahkan `review_state` (draft/in_review/changes_requested/rejected/approved), `processing_state` (scanning/extracting/preview_ready/indexing/ready/failed/quarantined), dan `publication_state` (unpublished/published/superseded/withdrawn). Freshness berasal dari review/expiry date; klasifikasi bukan salah satu state tersebut. Rollback selalu membuat draft versi baru, tidak mengubah histori.

Pemeriksaan expiry juga dilakukan ketika query, bukan hanya scheduler. Review 6 bulan tidak otomatis sama dengan expiry 6 bulan: expiry dari tanggal berlaku atau aturan kategori; fallback 12 bulan tanpa pembaruan adalah kebijakan yang perlu diputuskan organisasi.

**Format yang belum:** DOC lama membutuhkan LibreOffice sandbox; ZIP ditolak. Jika ZIP disetujui V1: batasi total decompressed bytes/file count/depth, tolak nested archive/path traversal/symlink, scan setiap member; bukan extract-all tanpa batas. Dukungan library tidak otomatis berarti dukungan produk.

## 5. RAG: WeKnora di belakang policy gate

- **Default off.** Tanpa `AI_PROVIDER=weknora-local`, portal, reader, dan pencarian kata tetap
  berjalan; asisten menyatakan belum aktif. Tidak ada provider cloud, API key, atau fallback.
- **Yang dikirim ke WeKnora** hanya Markdown versi final-approved dan judul bertanda versi.
  WeKnora tidak pernah menerima user, role, atau grant; ia tidak memutuskan siapa boleh membaca.

Alur satu pertanyaan:

1. Cek sesi, akun aktif, rate limit (5/menit, satu generasi aktif per akun) dan budget.
2. IntraDocs menghitung **daftar knowledge ID yang boleh dibaca actor** (versi aktif, terbit,
   tidak kedaluwarsa/dicabut, sesuai scope dan klasifikasi); pencarian WeKnora dibatasi daftar itu.
3. Gerbang relevansi: kandidat di bawah ambang kemiripan dibuang; tanpa bukti → abstain, tanpa
   memanggil model. Sapaan dan pertanyaan tentang kemampuan dijawab tanpa model.
4. Jawaban tersusun (opsional, `AI_GENERATION`) memakai model lokal. Konteks dokumen adalah data
   tak tepercaya; tidak ada tool shell/SQL/web atau kemampuan menulis.
5. **Setiap sitasi divalidasi ulang ke database** pada setiap request: versi masih boleh dibaca
   dan teks kutipan verbatim ada di Markdown kanonik. Teks buatan model (summary) tidak pernah
   menjadi sitasi. Pencabutan berlaku pada request berikutnya, walau record WeKnora belum dihapus.
6. Riwayat percakapan milik pemiliknya; saat dibuka ulang, jawaban yang sumbernya kini dicabut
   disembunyikan.

Validasi sitasi tidak membuktikan klaim benar; grounding dinilai dengan 40 pertanyaan berlabel
(`pnpm rag:eval`, Q4) dan tetap butuh review pemilik domain. Prompt/regex saja tidak membuat RAG
kebal prompt injection — setiap lapisan di atas tetap diperlukan.

## 6. Operasi dan pertumbuhan

- Audit append-only untuk aplikasi: upload, review, publish, akses/unduh sensitif, perubahan izin dan konfigurasi. Kirim salinan ke log sink terpisah bila tersedia; DB biasa tidak diklaim WORM/tamper-proof. Logs aplikasi tidak menyimpan isi dokumen/prompt/token rahasia.
- Analitik dibatasi scope; popular queries di-redact/kurasi, bukan publikasi pertanyaan mentah. Search-zero-rate = pencarian selesai dengan nol hasil yang bisa diakses / pencarian selesai; approval duration dari submit sampai keputusan akhir; active docs dihitung dari pointer sah. “Accuracy” hanya dari evaluasi berlabel atau tidak ditampilkan.
- Pantau latency/error, queue age, scan/parse/index failures, token usage/cost, disk, DB connections, stale review, SSO sync. Health/readiness dan alarm punya pemilik serta runbook. AI down → reader dan lexical search tetap berjalan; scanner down → unggahan menunggu, bukan dianggap aman.
- Backup DB + object versions + manifest, enkripsi in transit/at rest dan secret manager organisasi. Usulan target pemulihan RPO ≤15 menit/RTO ≤4 jam memerlukan dukungan PITR dan backup objek; harus diuji restore, bukan sekadar backup berhasil. Tidak ada angka SLA availability yang dijanjikan tanpa desain HA.
- Retensi dokumen berjalan otomatis di worker (arsip setelah masa tenggang, eskalasi review terlambat). Retensi produksi/legal hold tetap keputusan organisasi dan tidak mewarisi default demo. Delete harus menjangkau objek, indeks, cache dan dependensi chat; backup mengikuti jadwal expiry yang disetujui. Restore harus menerapkan ulang pencabutan izin/tombstone sebelum portal dibuka.
- Mulai dari baseline beban Q5. Optimalkan query/index/pooling, lalu tambah web/worker replica sesuai bottleneck; converter dan model diskalakan terpisah. ANN/HNSW baru diaktifkan setelah exact search baseline, EXPLAIN dan recall ACL sempit diuji; iterative scans membantu filtered recall tetapi harus diverifikasi pada query nyata. Search service khusus hanya jika relevansi/latency masih gagal setelah optimasi, bukan karena “enterprise harus microservices”.

## Referensi primer

- [Next.js: data security](https://nextjs.org/docs/app/guides/data-security) dan [self-hosting](https://nextjs.org/docs/app/guides/self-hosting).
- [PostgreSQL row security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html): owner/superuser/BYPASSRLS dan FORCE RLS.
- [Better Auth](https://www.better-auth.com/docs/authentication/email-password) dan [Generic OAuth/OIDC](https://better-auth.com/docs/plugins/generic-oauth).
- [pg-boss](https://github.com/timgit/pg-boss): queue berbasis PostgreSQL.
- [Tencent/WeKnora](https://github.com/Tencent/WeKnora) v0.8.0 (MIT).
- [OWASP File Upload](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html) dan [Prompt Injection Prevention](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html).
