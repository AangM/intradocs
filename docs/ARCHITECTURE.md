# Arsitektur — sederhana pada operasi, ketat pada batas data

Status v0.2: acuan development lokal untuk dua orang tanpa deadline. Persetujuan organisasi pada D04–D07 di [README.md](README.md) hanya memblokir pemakaian data nyata/go-live, bukan coding dengan fixtures. Tidak ada klaim benchmark atau sertifikasi keamanan.

## 1. Stack yang dipilih

| Lapisan            | Pilihan                                                                                                           | Alasan / batas                                                                                                                                                             |
| ------------------ | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web + API          | Next.js 16 App Router, React, TypeScript strict, Node.js 24 LTS                                                   | Satu aplikasi untuk portal dan admin; server-rendered reader, client JS hanya untuk interaksi. Tidak menambah backend bisnis kedua.                                        |
| UI                 | CSS Modules + CSS variables mentor; Radix untuk primitive aksesibel; SVG sumber                                   | Lebih mudah mencapai fidelity daripada membawa tema bawaan Tailwind/shadcn. Markdown GFM melalui remark/rehype dengan sanitasi; MDX tidak dieksekusi.                      |
| Data               | PostgreSQL 17, pgvector ≥0.8, full-text search, pg_trgm; Drizzle + migrasi SQL                                    | Metadata, ACL, workflow, pencarian dan queue di satu sistem. SQL eksplisit untuk RLS/vector. PostgreSQL terkelola organisasi diutamakan.                                   |
| Identitas          | Better Auth stable; local credentials untuk development, Generic OAuth/OIDC untuk perusahaan; session server-side | Login nyata sejak lokal, bukan role-picker bypass. Tidak membangun IdP sendiri atau membeli layanan auth sebelum perlu.                                                    |
| Berkas             | Private filesystem saat lokal; adapter S3 untuk hosted/multi-instance                                             | Original, MD, provenance dan aset immutable; folder lokal di luar webroot dan Git. Vercel filesystem bukan storage persisten.                                              |
| Background         | Node worker + pg-boss + transactional outbox                                                                      | Retry, deduplication, indexing, pengingat, agregasi, dan notifikasi; tidak perlu Redis/Celery untuk pilot.                                                                 |
| Konversi/embedding | Python 3.12 runtime, Docling, openpyxl; local E5 small untuk embedding CPU                                        | Satu utilitas internal dengan modul convert/embed terpisah; bukan backend bisnis. Parsing dijalankan dalam subprocess sandbox. Runtime dimuat hanya pada profil knowledge. |
| AI                 | Adapter `embed` dan `generate`; Gemini API opsional untuk demo, endpoint privat untuk data organisasi             | Default off; tidak wajib GPU. Tanpa LangChain/agent framework atau fallback otomatis ke cloud lain.                                                                        |
| Delivery/QA        | pnpm; Docker; Vitest, pytest, Playwright, axe; CI di Git organisasi                                               | Patch dependency dipilih, diuji, dan dipin saat M0. Tidak memakai tag `latest`/beta atau menganggap versi mayor cukup aman.                                                |

### Profil eksekusi dan hosting

- **Lokal — pilihan pertama.** Profil `core`: PostgreSQL Docker; Next.js dan worker Node dengan hot reload; storage privat `var/storage` yang diabaikan Git. Profil `knowledge` menambah Python convert/embed dan scanner, hanya ketika M2–M4 membutuhkan. Host tidak perlu memasang Python. Preload model terverifikasi ke cache saat setup; dokumen tidak dikirim saat mengunduh model.
- **Demo AI murah.** Backend mengirim prompt terpilih ke Gemini hanya bila mode demo-cloud diaktifkan. Tidak ada model generasi besar di laptop. Profil `local-ai` (Ollama/endpoint kompatibel) bersifat opsional jika perangkat mendukung.
- **Deploy penuh awal — rekomendasi untuk tim kecil.** Jalankan container yang sama pada satu host persisten/private VM yang disetujui. Reuse DB/storage organisasi; durable volume hanya untuk single-host, beralih S3 sebelum scale-out. Lebih sedikit sambungan operasional daripada Vercel ditambah host worker dan beberapa free-tier terpisah. Single VM bukan HA; backup, TLS dan monitoring tetap wajib.
- **Vercel — opsi, tidak dipaksakan.** Cocok untuk Next.js/preview, tetapi pg-boss worker dan Python runtime tetap pada host persisten di luar Functions. Deploy penuh membutuhkan PostgreSQL, object storage dan koneksi backend yang nyata; laptop developer bukan worker produksi. Jangan mengartikan preview UI sebagai aplikasi end-to-end yang sudah siap dipakai.

Functions memiliki batas payload request/response 4,5 MB; berkas 50 MB tidak boleh melewati endpoint upload biasa di Vercel. Profil Vercel memakai direct-to-S3 staging setelah otorisasi, lalu finalize metadata/checksum; unduhan besar/sensitif lewat file gateway pada host persisten yang memeriksa session/ACL setiap request. Gateway memakai modul policy yang sama, bukan aturan izin kedua. Uji auth lintas host, CORS, pooling DB, RLS transaction-local, timeout, egress dan revoke sebelum profil ini dianggap selesai. Jangan menjalankan parser, daemon queue atau menyimpan berkas permanen di Functions. Vercel Workflows dapat menangani durable orchestration, tetapi tidak dipilih karena menambah ketergantungan platform yang belum perlu.

Vercel Hobby dibatasi personal/nonkomersial dan tidak menawarkan kolaborasi tim seperti Pro. Pro memasang harga developer seat; resource usage dan host worker/storage terpisah. Kita belum berlangganan layanan atau menetapkan tagihan. Hosting gratis bukan asumsi untuk penggunaan Telkom.

Web/worker memakai DB dan Storage adapter; worker mengirim bytes ke converter, web/worker memanggil embedding privat. Python runtime tidak mempunyai kredensial DB/S3/SSO/provider cloud dan tidak boleh egress. Endpoint convert hanya untuk worker; embed untuk backend berautentikasi. Scanner internal/ClamAV wajib untuk upload arbitrer; pada profil core tanpa scanner, unggah belum tersedia, bukan dilewatkan diam-diam.

Ini satu backend bisnis modular dengan worker dan satu utilitas parsing yang diisolasi, bukan delapan microservices dari kotak diagram mentor. Containerisasi saja belum sandbox yang cukup: converter non-root, read-only root, temp disk terbatas, seccomp/resource limits, tanpa mount host/secret, tanpa egress; endpoint hanya bisa dipanggil worker melalui autentikasi service/proxy internal.

Tidak langsung menambah Elasticsearch, Qdrant, Kafka, Kubernetes baru, GraphQL, atau Keycloak baru. Reuse platform organisasi; Kubernetes boleh menjadi target jika sudah dioperasikan Telkom. Docker Compose untuk pengembangan/pilot VM tidak diklaim high availability.

## 2. Batas modul dan data

Satu repository: `apps/web`, `apps/worker`, `apps/knowledge-runtime` (Python convert/embed); `packages/core` untuk aturan/domain/validasi bersama; `packages/db` untuk query/migrasi. `tests` berisi fixtures, integration, e2e dan evaluasi RAG. Jangan memecah setiap tabel menjadi service/package.

Modular berarti batas tanggung jawab, bukan banyak microservices: auth/identity, documents, approval, taxonomy, search, chat dan audit tetap dalam satu backend bisnis. Adapter hanya pada batas yang benar-benar berubah: **identity provider, Storage, Embeddings, LLM**. Queue tetap pg-boss; tidak membangun universal queue/plugin framework. Provider dipilih server-side dan allowlisted, tidak dari URL kiriman user. Ganti storage perlu copy+verifikasi checksum; ganti model embedding perlu staging reindex dan atomic cutover, bukan sekadar mengganti environment variable pada indeks lama.

| Kelompok entitas                             | Isi/invariant utama                                                                                                                                     |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Users, sessions, groups, memberships         | Identitas stabil `(issuer, subject)`, status aktif, unit, waktu sync; schema sesi mengikuti library auth.                                               |
| Roles, permissions, assignments              | Capability × cakupan kategori/unit; grants sensitif eksplisit; versi kebijakan untuk invalidasi.                                                        |
| Categories, labels, document_labels          | Category parent + urutan; maksimum tiga tingkat, tanpa cycle; dokumen menyimpan satu leaf category.                                                     |
| Documents                                    | ID stabil, slug, owner user/group, kategori, klasifikasi, active published-version pointer, withdrawn flag.                                             |
| Document_versions, assets                    | MD/source/provenance key, checksum, version number, revision hash, tanggal berlaku/review/expiry, manifest lampiran. Versi yang diajukan dibekukan.     |
| Approval_requests, steps, findings, comments | Versi/hash yang disetujui, aturan saat submit, approver/timestamp/keputusan/alasan; temuan keamanan dan penyelesaiannya.                                |
| Chunks, index_generations                    | Version ID, urutan, teks+heading, source locator, content hash, embedding/model version, full-text vector; staging tidak bisa dibaca sebagai publikasi. |
| Conversations, messages, citations           | Owner, daftar sumber/versi yang menjadi dependensi, klasifikasi turunan, status; tidak dibagikan publik.                                                |
| Favorites, feedback, notifications, events   | Preferensi pribadi, antrean koreksi, unread notification, aktivitas minimal untuk dashboard.                                                            |
| Audit_events, outbox, jobs                   | Actor/action/object/version/time/request ID; append-only untuk aplikasi; pengiriman ulang harus idempotent.                                             |

DB menentukan izin dan status, bukan frontmatter dari file upload. MD canonical disimpan sebagai object immutable, bukan hanya teks embedding: `documents/{id}/versions/{version}/content.md`, `provenance.json`, original dan aset. Chunk/search index adalah turunan yang dapat dibangun ulang. SHA-256 dan manifest mengikat semua artefak versi.

Kontrak API cukup berupa route handlers tervalidasi: upload/start+finalize+status; dokumen/list/detail/versions/download; submit/decision; search; conversations/messages; admin users/taxonomy/audit. Identitas dari sesi server, bukan `userId` kiriman client. Semua input/hasil dibatasi schema; pagination/filter allowlist, parameterized SQL, batas payload, correlation ID; conflict revisi memakai optimistic version/If-Match dan mengembalikan 409.

## 3. Otorisasi: server dan database

### Login sekarang, SSO kemudian tanpa rewrite

Lokal memakai email/password Better Auth dengan hash bawaan library dan session DB. Tidak ada sign-up publik; seed akun sintetis untuk lima role, credential acak per instalasi, bukan password hardcoded atau tombol ganti-role. Reset development melalui CLI lokal; tidak perlu SMTP/SMS. API tetap menegakkan RBAC. `local-dev` bind loopback; jangan mengekspos DB/storage lewat LAN secara default.

Siapkan `AuthIdentity` dengan internal user ID stabil dan external identity `(issuer, subject)`. Mode `oidc` ditargetkan untuk IdP organisasi, misalnya Entra ID **jika memang tersedia**, bukan asumsi Telkom memakainya. Jika hanya AD/LDAP/SAML, gunakan bridge organisasi; Keycloak baru hanya jika benar-benar diperlukan, tidak dipasang demi demo. Login SSO tidak perlu dibeli/dibangun dari nol.

Saat migrasi, account linking dilakukan melalui prosedur admin terverifikasi; jangan otomatis menggabungkan akun hanya karena email sama. Untuk profil `telkom-prod`, local demo credentials/seed/reset dimatikan; OIDC, MFA IdP, mapping grup dan offboarding diuji nyata. `NODE_ENV=production` tidak cukup menentukan keamanan: gunakan profil eksplisit local-dev/preview-demo/telkom-prod, agar production build lokal tetap bisa diuji tanpa membuka mode demo pada produksi perusahaan.

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

Hak edit tidak otomatis membuka semua draft orang lain. Grant sensitif membutuhkan persetujuan pemilik berwenang; jangan mempromosikan Viewer menjadi Contributor sekadar agar bisa membaca. Role kustom pada V1 dapat menyelesaikan kebutuhan read-only sensitif. Admin tidak boleh mengeskalasi diri atau menjadi dua approver atas versi sendiri. D01 adalah penguatan sengaja terhadap contoh matriks mentor.

- DAL `server-only` menjadi satu pintu query/otorisasi. Route protection/proxy hanya UX, bukan kontrol terakhir. RLS melindungi dokumen, versi, chunk, pesan dan metadata terkait; uji join/aggregate juga.
- Role DB aplikasi bukan owner/superuser dan tanpa BYPASSRLS; migration role terpisah. Aktifkan/FORCE RLS pada tabel terlindungi. Konteks actor dari sesi dipasang transaction-local; test pool reuse agar identitas tidak tertukar. Worker punya izin service terbatas, bukan bypass untuk endpoint user.
- ACL dan status difilter **di SQL sebelum hasil keluar ke aplikasi/model** pada lexical maupun vector query. HNSW boleh memindai kandidat internal database sebelum filter, tetapi tidak boleh ada teks kandidat tak berizin dalam respons/DAL context.
- Grant kategori diwariskan ke descendant; restrictive classification floor menang. Pemindahan kategori/perluasan akses memerlukan preview dampak dan persetujuan berwenang. Pengetatan izin berlaku segera, tidak menunggu reindex atau job malam.
- Periksa izin pada original, MD, gambar, citation, ekspor, counts, autocomplete, rekomendasi dan kemiripan. Gunakan download handler terautentikasi yang mem-proxy private file/object; pada Vercel handler ini berada di file gateway host persisten, bukan melewatkan file besar melalui Functions. Jangan gunakan URL baca presigned panjang umur. Upload presigned hanya menuju staging sementara, tidak dapat menimpa versi yang telah disetujui.
- Session cookie HttpOnly/Secure/SameSite, CSRF/origin validation, CSP, TLS; OIDC state/nonce/PKCE dan validasi issuer/audience. Mapping role dari grup IdP terverifikasi/allowlist; jangan dari email/domain atau input profil semata.
- Offboarding membutuhkan event/SCIM/sync IdP yang nyata; OIDC sendiri tidak memberi jaminan langsung. Target awal ≤5 menit setelah sumber direktori memberi perubahan, dengan TTL/fail-closed untuk data sensitif bila sync stale; wajib dibuktikan sebelum pilot organisasi, bukan syarat memulai M0 lokal. Revoke session lokal dan naikkan policy version.
- Recheck hak sumber saat histori chat dibuka, pesan lanjutan dikirim, ekspor, dan sebelum jawaban dilepas. Jika dependensi tidak lagi boleh dibaca, blokir seluruh percakapan terkait dengan pesan netral dan jangan gunakan ringkasannya sebagai konteks. Data yang sudah diunduh sebelumnya tidak bisa ditarik kembali secara ajaib.

## 4. Ingestion, approval, publication

### Implementasi terbatas M2a (7 September 2026)

Source M2a menjalankan teks ≤1 MiB secara sinkron: auth/scope → admission lease → scan ClamAV atas bytes yang sama → UTF-8/normalisasi deterministik → original+MD+provenance immutable → transaksi draft+source+receipt+audit. Tidak ada data publik atau knowledge AI sebelum workflow M3/M4. Input frontmatter bukan metadata otoritatif.

ClamAV adalah satu service opsional `knowledge` yang **wajib untuk upload**, bukan untuk reader. Python dan worker konversi belum dibutuhkan MD/TXT; tetap diperlukan sebelum format kompleks. Engine `1.4.6_base` dipilih dari [rilis patch resmi](https://blog.clamav.net/2026/08/clamav-154-and-146-security-patch.html); [image base dan volume signature](https://docs.clamav.net/manual/Installing/Docker.html) menghindari download ulang database penuh tiap container dibuat. TCP hanya loopback dan tidak memakai mount dokumen/credential. Belum dibuktikan berjalan/pull di sandbox.

Lease 90 detik, satu aktif/akun, retry terbatas dan duplicate owner-scoped; percobaan baru memakai version ID artefak baru agar manifest immutable tidak bentrok. Commit menolak actor/scope/lease yang berubah. Jika commit gagal, file tidak mempunyai versi yang dapat diakses melalui RLS. M2a.1 menambahkan GC operator (default dry-run, ≥24 jam, pin seluruh reference/receipt selesai/lease aktif, lock admission/commit, recheck dan jurnal). Snapshot RLS-filtered dilarang karena dapat salah menghapus dokumen di luar scope. Scheduler/retensi produksi, locking PostgreSQL nyata, dan restore masih gate terbuka sebelum pilot. Normalisasi MD hanya BOM/line-ending; TXT literal memakai fence lebih panjang daripada seluruh run backtick input. Provenance menyimpan peta line, bukan nomor halaman fiktif.

1. **Staging:** bind upload ke user/kategori; batas 50 MB/file, quota batch; validasi ekstensi, MIME, magic bytes, ukuran setelah dekompresi. Nama object dibuat sistem. Scan malware sebelum parsing. Hash mendeteksi duplikat; jangan mengungkap judul dokumen duplikat di luar izin.
2. **Konversi:** converter menerima bytes, bukan URL bebas; remote resources, macro, script dan external links tidak dieksekusi. MD/TXT dinormalisasi deterministik; Docling untuk PDF/DOCX; XLSX menjaga nama sheet, header, row/cell range dan cached values—tidak menjalankan formula. Nilai cache yang hilang ditandai, bukan dihitung/ditebak.
3. **Artefak:** simpan original, MD, gambar yang aman, provenance. PDF memakai halaman dan bila tersedia bounding box; DOCX/MD/TXT memakai heading/paragraph/line, XLSX sheet+range. Nomor halaman DOCX yang tidak stabil tidak boleh dikarang. Hasil yang kehilangan tabel/angka penting ditahan untuk koreksi.
4. **Preview & checks:** contributor membandingkan MD dengan original. Temuan secret/PII muncul sebelum bantuan LLM; secret nyata harus dihapus melalui versi baru, false positive memerlukan justifikasi reviewer berwenang. Scanner bukan bukti isi pasti aman. Metadata AI opsional V1 hanya saran; gagal AI tidak menghalangi pengisian manual.
5. **Submit:** bekukan content hash, metadata, klasifikasi, lampiran dan aturan review. Default satu tahap; Kritikal/Terbatas/Rahasia atau aturan kategori dua tahap. Dua actor berbeda, bukan author; tiap actor harus berizin atas isi. Perubahan sesudah submit membatalkan review lama dan mengulang tahap.
6. **Publish:** keputusan terakhir menulis state approved + outbox secara atomik. Worker membangun indeks staging **sesudah** approval. Verifikasi expected hash, jumlah chunk dan model version; transaksi terakhir menukar active-version pointer. Versi lama tetap aktif sampai swap, kecuali sudah expired/withdrawn. Job basi tidak boleh menerbitkan versi yang dicabut.
7. **Recovery:** unique job key `(version, step, pipeline_revision)`, retry terbatas dengan backoff, dead-letter/manual retry; crash dapat menyebabkan pengiriman ulang sehingga setiap side effect idempotent. Upload parsial, file orphan dan staging dibersihkan berdasarkan kebijakan retensi.

Pisahkan `review_state` (draft/in_review/changes_requested/rejected/approved), `processing_state` (scanning/extracting/preview_ready/indexing/ready/failed/quarantined), dan `publication_state` (unpublished/published/superseded/withdrawn). Freshness berasal dari review/expiry date; klasifikasi bukan salah satu state tersebut. Rollback selalu membuat draft versi baru, tidak mengubah histori.

Pemeriksaan expiry juga dilakukan ketika query, bukan hanya scheduler. Review 6 bulan tidak otomatis sama dengan expiry 6 bulan: expiry dari tanggal berlaku atau aturan kategori; fallback 12 bulan tanpa pembaruan adalah kebijakan yang perlu D07.

**Format V1:** aktifkan PPTX/OCR/HTML hanya setelah fixture dan locator lulus. OCR buruk ditandai; slide memakai slide number. DOC legacy membutuhkan LibreOffice sandbox; ZIP awalnya ditolak. Jika ZIP disetujui V1: batasi total decompressed bytes/file count/depth, tolak nested archive/path traversal/symlink, scan setiap member; bukan extract-all tanpa batas. Dukungan library tidak otomatis berarti dukungan produk.

## 5. RAG dan biaya inference

### Kebijakan AI yang dipilih untuk development

- **Default: off.** UI/auth/upload/reader dapat dikembangkan tanpa API key dan tanpa GPU. Chat jelas menyatakan belum aktif; test fixture tidak dipresentasikan sebagai jawaban model nyata.
- **Demo cloud: Gemini `gemini-2.5-flash-lite`.** Pilihan awal hemat untuk data sintetis/nonrahasia yang telah disetujui untuk uji. Pakai kuota gratis jika tersedia pada akun/region; jangan menjanjikan jumlah request gratis atau uptime. Aktifkan secara eksplisit di konfigurasi backend, API key di `.env.local`/secret manager, bukan browser atau chat. Bila kuota habis, tampilkan error/cooldown; tidak otomatis mengaktifkan billing atau berganti provider.
- **Berbayar kecil bila diperlukan.** Harga Standard text yang tercantum saat review: USD 0,10 per satu juta token input dan USD 0,40 per satu juta token output (termasuk thinking). Ini tarif provider, bukan biaya total sistem; hosting, pajak, retry dan model lain terpisah. Paid service tidak otomatis memenuhi data residency/approval perusahaan.
- **Data Telkom nyata: private/approved saja.** Gratis Gemini tidak boleh menerima informasi sensitif, rahasia atau pribadi; terms menyebut data unpaid dapat dipakai memperbaiki produk dan dibaca reviewer manusia. Paid service menyatakan prompt/response tidak dipakai memperbaiki produk, tetapi tetap memiliki logging/ketentuan lokasi pemrosesan. DPA, residency, retensi, endpoint dan klasifikasi yang boleh keluar tetap harus disetujui Telkom. Terbatas/Rahasia default wajib tetap privat.

Cloud-demo dibatasi corpus demonstrasi yang di-allowlist admin (misalnya manifest fixture/hash); setiap turn memeriksa profil, izin, provenance dan policy egress. Jangan menganggap label “Publik” atau checkbox kontributor sebagai izin mengirim data keluar. Pertanyaan/riwayat juga dapat memuat rahasia; batasi ke penguji yang memahami aturan, tampilkan peringatan, redaksi/penolakan temuan sensitif, dan jangan mengklaim detektor mampu menjamin semua input aman. Metadata request tidak perlu mengandung nama/email/role pengguna. Di profil telkom-prod, endpoint cloud ditolak kecuali konfigurasi persetujuan organisasi secara eksplisit mengizinkannya; tidak ada public-web grounding atau tools pada RAG.

Embedding baseline `intfloat/multilingual-e5-small` (384 dimensi, 512 token) berjalan CPU melalui modul embed Python internal; prefix query/passage mengikuti model. Corpus dan embedding tetap lokal saat demo cloud—hanya pertanyaan dan potongan terpilih yang boleh dikirim untuk generasi. Query embedding memiliki deadline/concurrency terpisah dari parsing agar OCR tidak memblokir search.

Generasi privat melalui adapter endpoint organisasi/OpenAI-compatible; Qwen3-8B via runtime lokal hanya kandidat opsional jika perangkat memadai, bukan prasyarat coding. Model produksi tetap harus lolos Q4; model kecil tidak otomatis cukup untuk SOP kritikal. Pin ID/revision/tokenizer dan test model sebelum mengganti; pantau deprecation/availability saat M4. Tidak mengejar model terbaru hanya karena namanya baru.

Alur satu pertanyaan:

1. Cek sesi, scope, profil data, rate limit, quota dan izin endpoint AI. Default off/privat; pengecualian demo-cloud mengikuti allowlist dan kebijakan di atas, bukan akses cloud untuk semua dokumen.
2. Bangun query dari pertanyaan dan riwayat pendek yang masih berizin. Riwayat bukan bukti: keluarkan jawaban lama dari konteks generasi bila sumbernya superseded/expired/withdrawn; retrieve ulang pada setiap turn. Retrieve hanya active-version yang published, approved, ready, tidak expired/withdrawn, serta bisa dibaca user.
3. Gabungkan PostgreSQL full-text `simple`/title-code boosting + vector cosine memakai reciprocal rank fusion. PostgreSQL `ts_rank` **bukan BM25**; ini perubahan teknis sengaja dari S02 untuk mengurangi komponen. Uji recall bahasa Indonesia dan kode teknologi. Search lexical tetap hidup jika endpoint embedding mati.
4. Mulai chunk 300–400 token embedding dengan overlap ±40, tetap di bawah 512 termasuk heading/prefix; tabel membawa ulang header dan locator. Deduplikasi kandidat; kirim kira-kira enam chunk relevan, bukan seluruh dokumen. Potongan panjang dipisah pada struktur yang valid.
5. Satu generasi terstruktur berisi jawaban dan citation IDs dari allowlist. Konteks dokumen diperlakukan sebagai data tak tepercaya; instruksi di dalamnya tidak dieksekusi. Tidak ada tool shell/SQL/web atau kemampuan approve/write pada chatbot.
6. SSE mengirim status retrieval/penyusunan. Buffer jawaban, validasi schema/sumber/izin ulang, sanitasi Markdown, lalu kirim hasil final. Tidak menampilkan token mentah yang belum lolos pemeriksaan. Model tidak menentukan sendiri URL sumber.
7. Simpan provenance dan feedback. Jika bukti kurang/bertentangan, jawab keterbatasannya; jangan fallback ke “pengetahuan umum” untuk menjawab kebijakan internal. Format sitasi: document ID, version ID, chunk/heading, halaman/sheet/slide bila tersedia.

Validasi ID sitasi tidak membuktikan klaim benar; grounding dinilai dengan gold questions dan review domain (Q4). Prompt/regex saja tidak membuat RAG kebal prompt injection. Setiap lapisan—ACL, approval, data/command separation, output validation, tanpa action tools—tetap diperlukan.

**Budget awal yang dapat dikonfigurasi:** pertanyaan ≤2.000 karakter; konteks total ≤6.000 token model generasi; jawaban ≤900 token; maksimal dua turn terakhir dalam budget; satu generasi/turn, tanpa loop agent/reranker/LLM-judge rutin. Embedding dokumen hanya untuk chunk hash baru. Ringkasan/metadata sekali per versi, bukan setiap pembacaan.

Batas awal 5 request AI/menit/user, satu generasi aktif/user, 50 turn/hari/developer untuk demo, dan tombol stop. Untuk mode paid, usulan budget aplikasi USD 5/bulan per project: reservasi biaya terburuk secara atomik sebelum request, reconcile usage aktual setelahnya, tolak saat budget habis. Alert billing provider bukan hard cap; biaya request in-flight/retry/tax tetap perlu dicatat dan key dirotasi jika bocor. Cache jawaban lintas user dinonaktifkan; request data privat `no-store`. Jika cache kelak ditambahkan, key wajib memuat permission fingerprint, versi sumber dan model, dengan invalidasi revoke/publish. Jangan menghemat biaya dengan melemahkan ACL.

## 6. Operasi dan pertumbuhan

- Audit append-only untuk aplikasi: upload, review, publish, akses/unduh sensitif, perubahan izin dan konfigurasi. Kirim salinan ke log sink terpisah bila tersedia; DB biasa tidak diklaim WORM/tamper-proof. Logs aplikasi tidak menyimpan isi dokumen/prompt/token rahasia.
- Analitik dibatasi scope; popular queries di-redact/kurasi, bukan publikasi pertanyaan mentah. Search-zero-rate = pencarian selesai dengan nol hasil yang bisa diakses / pencarian selesai; approval duration dari submit sampai keputusan akhir; active docs dihitung dari pointer sah. “Accuracy” hanya dari evaluasi berlabel atau tidak ditampilkan.
- Pantau latency/error, queue age, scan/parse/index failures, token usage/cost, disk, DB connections, stale review, SSO sync. Health/readiness dan alarm punya pemilik serta runbook. AI down → reader dan lexical search tetap berjalan; scanner down → unggahan menunggu, bukan dianggap aman.
- Backup DB + object versions + manifest, enkripsi in transit/at rest dan secret manager organisasi. Usulan target pemulihan RPO ≤15 menit/RTO ≤4 jam memerlukan dukungan PITR dan backup objek; harus diuji restore, bukan sekadar backup berhasil. Tidak ada angka SLA availability yang dijanjikan tanpa desain HA.
- Default untuk data demo: chat 7 hari, audit 30 hari, staging gagal 24 jam; dokumen demo bisa di-reset dengan konfirmasi. Retensi produksi/legal hold tetap menunggu D07 dan tidak mewarisi default demo otomatis. Delete harus menjangkau objek, indeks, cache dan dependensi chat; backup mengikuti jadwal expiry yang disetujui. Restore harus menerapkan ulang pencabutan izin/tombstone sebelum portal dibuka.
- Mulai dari baseline beban Q5. Optimalkan query/index/pooling, lalu tambah web/worker replica sesuai bottleneck; converter dan model diskalakan terpisah. ANN/HNSW baru diaktifkan setelah exact search baseline, EXPLAIN dan recall ACL sempit diuji; iterative scans membantu filtered recall tetapi harus diverifikasi pada query nyata. Search service khusus hanya jika relevansi/latency masih gagal setelah optimasi, bukan karena “enterprise harus microservices”.

## Referensi primer untuk keputusan

Diakses 6 September 2026; fitur library bukan bukti kapasitas deployment atau kepatuhan Telkom.

- [Next.js: data security](https://nextjs.org/docs/app/guides/data-security) dan [self-hosting](https://nextjs.org/docs/app/guides/self-hosting): DAL/server authorization dan reverse proxy.
- [PostgreSQL row security](http://postgresql.org/docs/current/ddl-rowsecurity.html): owner/superuser/BYPASSRLS dan FORCE RLS.
- [pgvector](https://github.com/pgvector/pgvector): hybrid FTS/vector, exact/ANN dan filtered-search caveats.
- [Better Auth Generic OAuth](https://better-auth.com/docs/plugins/generic-oauth): klien OIDC terhadap IdP yang sudah ada.
- [pg-boss](https://github.com/timgit/pg-boss/blob/master/README.md): queue berbasis PostgreSQL.
- [Docling supported formats](https://docling-project.github.io/docling/usage/supported_formats/): Markdown/JSON, format modern, legacy LibreOffice.
- [Multilingual E5 small](https://huggingface.co/intfloat/multilingual-e5-small) dan [Qwen3-8B](https://huggingface.co/Qwen/Qwen3-8B): kandidat untuk evaluasi, bukan jaminan kualitas domain.
- [OWASP File Upload](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html) dan [Prompt Injection Prevention](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html): kontrol berlapis dan batas keamanan.
- [GitDoc](http://gitdoc.ai/): referensi pengalaman dokumentasi, bukan spesifikasi sistem Telkom.
- [Better Auth email/password](https://www.better-auth.com/docs/authentication/email-password): login lokal dengan session dan password hashing library.
- [Vercel Hobby](https://vercel.com/docs/plans/hobby) dan [Functions limits](https://vercel.com/docs/functions/limitations): nonkomersial/kolaborasi serta payload/durasi. Jangan membeli plan sebelum kebutuhan deploy jelas.
- [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing), [terms](https://ai.google.dev/gemini-api/terms) dan [deprecations](https://ai.google.dev/gemini-api/docs/deprecations): biaya, data unpaid/paid dan pemeriksaan umur model; dibaca 6 September 2026.
