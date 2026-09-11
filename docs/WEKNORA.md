# M4 — WeKnora lokal sebagai mesin RAG

Status: **implementasi selesai, acceptance sebagian terblokir.** Baca [bagian 8](#8-status-gate) sebelum menyatakan M4 lulus. IntraDocs tetap system of record dan policy gate; WeKnora hanya mesin index/retrieval yang tidak pernah memutuskan siapa boleh membaca apa.

Referensi kontrak: [Tencent/WeKnora](https://github.com/Tencent/WeKnora) v0.8.0, lisensi MIT (`LICENSE` + `THIRD_PARTY_NOTICES.md` upstream), `docs/swagger.json` (`basePath /api/v1`) dan `internal/types/chat.go` untuk bentuk frame SSE. Diakses 10 September 2026.

## 1. Pembagian tanggung jawab

| Tetap di IntraDocs                                           | Didelegasikan ke WeKnora                       |
| ------------------------------------------------------------ | ---------------------------------------------- |
| Identity, session, RBAC, scope kategori, grant eksplisit     | Chunking dan embedding                         |
| Klasifikasi, approval, publication state, revoke, expiry     | Index vektor + keyword, hybrid search          |
| Menentukan versi mana yang boleh diindeks                    | Skoring kandidat                               |
| Menentukan knowledge ID mana yang boleh dicari seorang actor | Penyusunan jawaban (opsional, `AI_GENERATION`) |
| Validasi ulang setiap sitasi sebelum keluar                  | —                                              |
| Audit, budget, rate limit, locator dokumen                   | —                                              |

Tidak ada auth, ACL, approval, atau source of truth yang diduplikasi di WeKnora. WeKnora tidak pernah menerima user ID, email, role, atau daftar grant IntraDocs. Yang dikirim hanya: teks Markdown versi final-approved, judul bertanda versi, pertanyaan, dan daftar knowledge ID yang sudah diotorisasi.

## 2. Kontrak data

### 2.1 IntraDocs → WeKnora (ekspor)

Satu `document_version` menjadi satu **manual knowledge** WeKnora.

| Field WeKnora | Isi                                                               |
| ------------- | ----------------------------------------------------------------- |
| `title`       | `[IntraDocs:<version_id>] <judul dokumen>` — penanda rekonsiliasi |
| `content`     | komentar provenance + baris sumber + Markdown kanonik apa adanya  |

```
<!-- intradocs:document=<uuid> version=<uuid> -->
> Sumber: IntraDocs · <kategori> · versi <label> · klasifikasi <klasifikasi>.

<isi Markdown final-approved>
```

Isi dokumen disalin verbatim. Instruksi apa pun di dalamnya adalah **data**, bukan perintah; tidak ada preamble yang diandalkan untuk itu — lihat [bagian 5](#5-batas-keamanan).

### 2.2 Tabel pemetaan (`app.rag_index_entries`) dan antrean (`app.rag_export_queue`)

Dua tabel, tanggung jawab berbeda. Keduanya data turunan: hilang pun dapat dibangun ulang dari IntraDocs.

`app.rag_index_entries` — apa yang saat ini ada di WeKnora. Kunci utama `version_id`, sehingga satu versi tidak mungkin punya dua record.

| Kolom             | Arti                                                         |
| ----------------- | ------------------------------------------------------------ |
| `version_id` (PK) | Versi IntraDocs                                              |
| `document_id`     | Dokumen pemilik versi                                        |
| `knowledge_id`    | ID WeKnora, unik                                             |
| `source_hash`     | `markdown_sha256` versi saat diekspor; penahan kiriman ulang |
| `chunk_count`     | Jumlah bagian yang dilaporkan exporter                       |
| `exported_at`     | Waktu ekspor terakhir berhasil                               |

`app.rag_export_queue` — pekerjaan yang belum selesai. Satu baris per versi (`version_id` unik), dengan `operation` `upsert` atau `remove`, `state` `pending`/`running`/`done`/`dead`/`cancelled`, plus `attempts`, `available_at`, `lease_token`, `lease_until`, `error_code`.

Baris antrean tidak pernah dihapus, hanya berubah state, sehingga setiap percobaan ekspor tetap dapat ditelusuri.

**Tidak ada tombstone `revoked`.** Pencabutan bekerja lewat dua lapis: RLS `is_active_version` menolak versi itu pada request berikutnya, dan rekonsiliasi mengantre `remove` agar record WeKnora ikut dihapus. Lapisan pertama yang menjaga keamanan; lapisan kedua hanya kebersihan.

### 2.3 WeKnora → IntraDocs (retrieval)

`SearchResult` dipakai sebagian saja: `knowledge_id`, `id` (chunk), `content`, `score`. Field lain — termasuk `knowledge_custom_metadata` — **tidak dipercaya** dan tidak dipakai untuk otorisasi. `knowledge_id` divalidasi ulang ke `app.rag_index_entries` di bawah RLS pemanggil; hit yang tidak cocok ditolak dan diaudit.

## 3. Menjalankan dari clean checkout

Prasyarat: Node.js 24, pnpm 10.34.5, Docker Compose v2. Untuk retrieval juga: [Ollama](https://ollama.com) di host.

```sh
pnpm install
pnpm setup:local                 # PostgreSQL IntraDocs, migrasi, seed sintetis
ollama pull bge-m3               # model embedding lokal, ~1,1 GB
pnpm weknora:setup               # profil weknora + bootstrap tenant/KB
```

`pnpm weknora:setup` menulis `WEKNORA_BASE_URL`, `WEKNORA_API_KEY`, `WEKNORA_KNOWLEDGE_BASE_ID` dan `WEKNORA_TENANT_ID` ke `.env.local`, dan credential akun layanan ke `var/weknora-service.json` (0600, Git-ignored). **Script tidak menyalakan AI.** Aktivasi tetap keputusan eksplisit:

```sh
# .env.local
AI_PROVIDER=weknora-local        # retrieval
# AI_GENERATION=weknora-local    # opsional, butuh model KnowledgeQA lokal terdaftar
WEKNORA_DISABLE_REGISTRATION=true
```

Lalu:

```sh
pnpm weknora:sync                # ekspor versi final-approved, idempoten
pnpm weknora:status              # health, readiness, jumlah entri index
pnpm dev
```

`pnpm weknora:stop` menghentikan profil tanpa menghapus volume. `pnpm services:stop` hanya menyentuh PostgreSQL IntraDocs.

## 4. Konfigurasi

Semua server-side. `scripts/runtime-env.ts` memilih variabel mana yang sampai ke proses web dan worker; `WEKNORA_DB_PASSWORD`, `WEKNORA_REDIS_PASSWORD`, `WEKNORA_JWT_SECRET` dan `WEKNORA_AES_KEY` **sengaja tidak diteruskan** — itu milik container.

| Variabel                      | Default | Catatan                                                       |
| ----------------------------- | ------- | ------------------------------------------------------------- |
| `AI_PROVIDER`                 | `off`   | `off` \| `weknora-local`. Nilai lain ditolak saat boot        |
| `AI_GENERATION`               | `off`   | Butuh `AI_PROVIDER=weknora-local`                             |
| `WEKNORA_BASE_URL`            | —       | Wajib origin http loopback, tanpa path/credential             |
| `WEKNORA_API_KEY`             | —       | 16–512 karakter tercetak; tidak pernah diserialisasi          |
| `WEKNORA_KNOWLEDGE_BASE_ID`   | —       | Satu KB, dipilih server. Client tidak bisa mengubahnya        |
| `WEKNORA_GENERATION_MODEL_ID` | —       | Pin model penjawab. Wajib bila lokasi generasi `external`     |
| `WEKNORA_MAX_CANDIDATES`      | 6       | Ceiling 20                                                    |
| `WEKNORA_MAX_SCOPE_DOCUMENTS` | 200     | Ceiling 500. Batas versi yang boleh disebut dalam satu filter |
| `WEKNORA_SEARCH_TIMEOUT_MS`   | 15000   | Ceiling 60000                                                 |
| `WEKNORA_CHAT_TIMEOUT_MS`     | 60000   | Ceiling 180000                                                |
| `WEKNORA_MAX_RESPONSE_BYTES`  | 2 MiB   | Ceiling 8 MiB                                                 |
| `WEKNORA_EXPORT_BATCH_SIZE`   | 25      | Ceiling 100                                                   |
| `WEKNORA_EXPORT_MAX_ATTEMPTS` | 5       | Ceiling 10                                                    |
| `WEKNORA_MAX_QUESTION_CHARS`  | 2000    | Ceiling 4000                                                  |
| `WEKNORA_MAX_SNIPPET_CHARS`   | 700     | Ceiling 2000                                                  |
| `WEKNORA_MAX_ANSWER_CHARS`    | 4000    | Ceiling 8000                                                  |

Budget boleh diturunkan, tidak boleh dinaikkan melewati ceiling. Rate limit permintaan AI: 5/menit/akun dan satu generasi aktif/akun, di dalam proses web (satu proses = seluruh deployment pada profil local-dev).

## 5. Batas keamanan

- **AI default off.** Tanpa konfigurasi, tidak ada satu pun request keluar dari proses; UI, auth, katalog dan reader tetap berjalan.
- **Hanya loopback.** `WEKNORA_BASE_URL` wajib `http://127.0.0.1|localhost|[::1]`. Host jaringan, HTTPS eksternal, path, dan credential dalam URL ditolak saat boot.
- **Key tidak pernah keluar.** `describeAiConfig()` adalah satu-satunya serialiser konfigurasi AI dan hanya mengeluarkan mode, origin, KB ID dan boolean `apiKeyConfigured`. Adapter tidak mengikuti redirect, sehingga key tidak bisa dialihkan ke host lain. Body error WeKnora tidak pernah diteruskan; hanya status.
- **Client tidak memilih apa pun selain pertanyaan.** `parseChatBody` menolak setiap field lain, termasuk `system`, `model`, `knowledge_base_id` dan `knowledge_ids`.
- **Yang diekspor hanya versi final-approved dan aktif.** Draft, `in_review`, versi lama, withdrawn dan expired tidak pernah masuk index.
- **Retrieval divalidasi dua kali.** Sekali sebelum query (menyusun scope), sekali sesudah WeKnora menjawab, di transaksi baru. Grant yang dicabut di antara keduanya membuat request yang sama gagal tertutup.
- **Revoke dan expiry berlaku saat query,** bukan menunggu sinkronisasi. Chunk basi di WeKnora tidak bisa dipakai karena `rag_index_entries` sudah tidak mengizinkannya.
- **Prompt injection adalah data.** Isi dokumen tidak pernah mengubah scope, karena scope dihitung dari SQL sebelum dan sesudah retrieval, bukan dari teks. Tidak ada tool, web search, MCP, agent sandbox atau memory lintas sesi — `agent_enabled` dan `web_search_enabled` dikirim `false` secara eksplisit, bukan diserahkan ke default WeKnora.
- **Tidak ada history lintas user.** Session WeKnora dibuat dan dihapus di dalam satu request. Satu API key layanan berarti session yang persisten akan menumpuk riwayat semua pengguna IntraDocs di bawah satu principal; itu sebabnya session bersifat ephemeral. Respons memakai `Cache-Control: private, no-store` dan `Vary: Cookie`.
- **Tanpa bukti, sistem abstain.** Jika tidak ada sitasi yang lolos validasi, teks jawaban dibuang dan diganti pesan abstain — bukan ditampilkan dengan disclaimer.
- **Locator tidak dikarang.** Anchor heading dihitung dengan mencari potongan di dalam Markdown yang memang boleh dibaca actor. Kalau tidak ketemu, sitasi tetap menunjuk dokumen tanpa anchor.

Yang **tidak** dilakukan M4: tidak mengaktifkan provider cloud, billing, web search, MCP remote, agent sandbox, knowledge graph, Langfuse, atau multi-tenant sharing. Semuanya di luar himpunan nilai yang diterima konfigurasi, bukan sekadar default off.

## 6. Resource

Profil `weknora` menambah **tiga container**, bukan delapan seperti compose upstream.

| Service            | Image                            | Limit            | Volume           |
| ------------------ | -------------------------------- | ---------------- | ---------------- |
| `weknora-postgres` | `paradedb/paradedb:v0.22.2-pg17` | 1 GB / 1 CPU     | `weknora_pgdata` |
| `weknora-redis`    | `redis:7-alpine`                 | 192 MB / 0,5 CPU | tidak ada        |
| `weknora-app`      | `wechatopenai/weknora-app`       | 2 GB / 2 CPU     | `weknora_files`  |

Ukuran image (amd64, terkompresi): weknora-app 545 MB, paradedb 496 MB, redis 39 MB. Di disk setelah unpack sekitar **1,7 GB + 1,5 GB + 40 MB**. Model embedding `bge-m3` menambah ~1,1 GB di cache Ollama. Sediakan **≥6 GB disk bebas** dan **≥4 GB RAM** untuk profil ini, di luar kebutuhan IntraDocs sendiri.

Yang dihilangkan dari deployment upstream dan alasannya:

| Service                              | Alasan dilewati                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------------ |
| `docreader`                          | IntraDocs mengirim Markdown yang sudah dikonversi; OCR/parsing (~4 GB) tidak dipakai |
| `frontend`                           | Integrasi lewat REST; tidak menambah UI kedua yang perlu diamankan                   |
| `neo4j`                              | Knowledge graph di luar scope M4                                                     |
| `minio`                              | Storage lokal cukup; object storage belum diperlukan                                 |
| `qdrant`/`milvus`/`weaviate`/`doris` | `RETRIEVE_DRIVER=postgres` sudah memberi vektor + keyword                            |
| `searxng`                            | Web search dilarang                                                                  |
| `langfuse` (5 container)             | Observability memakai health check dan baris audit `rag.*` di `app.audit_events`     |
| `sandbox`, `mcp`, `dex`              | Eksekusi agent, MCP dan OIDC di luar scope                                           |

Batas lain: concurrency pool WeKnora 2, ekspor berjalan serial (satu WeKnora lokal dengan embedding CPU tidak diuntungkan paralelisme), chunk 400 token dengan overlap 40, indexing strategy hanya `vector_enabled` + `keyword_enabled`.

**Mengapa PostgreSQL terpisah.** Rancangan pertama memakai ulang container PostgreSQL IntraDocs dengan database dan role sendiri. Itu gagal: `RETRIEVE_DRIVER=postgres` membuat ekstensi `pg_search` milik ParadeDB, yang tidak ada pada image `pgvector/pgvector`, sehingga migrasi WeKnora berhenti di tengah dan registrasi gagal dengan `column "parser_engine_config" does not exist`. Instance terpisah juga memastikan migrasi WeKnora tidak mungkin menyentuh data IntraDocs. `pnpm weknora:setup` membersihkan sisa database/role dari percobaan lama.

## 7. Troubleshooting

| Gejala                                                | Penyebab dan tindakan                                                                               |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `AI_PROVIDER hanya off atau weknora-local`            | Nilai lain memang tidak diimplementasikan. Tidak ada fallback provider                              |
| `WEKNORA_BASE_URL harus origin http loopback`         | Endpoint jaringan ditolak by design. M4 hanya untuk instance lokal                                  |
| `AI_GENERATION membutuhkan AI_PROVIDER=weknora-local` | Generasi tanpa retrieval tervalidasi tidak diizinkan                                                |
| `WeKnora tidak menjadi healthy`                       | `docker compose --env-file .env.local --profile weknora logs weknora-app`                           |
| `failed to create workspace` saat setup               | Migrasi WeKnora tidak selesai. Cek log untuk ekstensi yang hilang; pastikan memakai image ParadeDB  |
| `WeKnora tidak mengembalikan API key`                 | `WEKNORA_TENANT_AUTO_CREATE_API_KEY` harus `true` saat tenant dibuat                                |
| `pnpm weknora:sync` melaporkan antrean `dead`         | `SELECT * FROM app.rag_export_status()`. Retry dibatasi 5 kali, lalu job berhenti sebagai `dead`    |
| Rekonsiliasi tampak tidak jalan                       | Lock advisory `(719284,1)` dipegang satu transaksi saja; worker dan `weknora:sync` saling menunggu  |
| Jawaban selalu abstain                                | Cek `pnpm weknora:status`. Index kosong, model embedding mati, atau memang tidak ada sumber berizin |
| Sitasi tanpa anchor                                   | Potongan tidak ditemukan di Markdown versi tersebut. Ini benar: locator tidak dikarang              |
| `429`/budget                                          | 5 permintaan AI per menit per akun                                                                  |

| `SSRF validation failed: hostname host.docker.internal is restricted` | WeKnora memblokir target SSRF. `compose.yaml` sudah menambahkan nama itu saja ke `SSRF_WHITELIST_EXTRA`; jangan menggantinya dengan wildcard |
| Ekspor sukses tetapi pencarian kosong | Knowledge manual dibuat berstatus `draft`. Exporter memicu `batch-reparse`; jika versi WeKnora berbeda, cek `parse_status` di DB WeKnora |
| `bind: An attempt was made to access a socket in a way forbidden` | Port masuk rentang cadangan WinNAT. `netsh interface ipv4 show excludedportrange protocol=tcp`, lalu pilih port di luar rentang itu |
| `converter_unavailable` saat unggah | Jaringan `conversion` harus `internal: false` selama worker berjalan di host; port internal tidak dapat dipublikasikan |

Log yang aman dibagikan: `pnpm weknora:status` dan baris audit `rag.*` di `app.audit_events`. Keduanya tidak memuat key, pertanyaan, atau isi dokumen.

## 8. Status gate

Dijalankan pada RC M1–M3 dengan profil `weknora` hidup, PostgreSQL lokal, dan Ollama `bge-m3` di host.

| Gate                                        | Hasil                                                         |
| ------------------------------------------- | ------------------------------------------------------------- |
| Unit                                        | **266 lulus**, 0 gagal, 3 skip                                |
| Konten (render Markdown)                    | **3 lulus** — sebelumnya gagal impor `react`, kini diperbaiki |
| Integrasi PostgreSQL/RLS                    | **37 lulus**, 0 gagal                                         |
| HTTP (termasuk 11 uji RAG)                  | **32 lulus**, 0 gagal                                         |
| E2E browser desktop + mobile                | **14 lulus**, 0 gagal                                         |
| Lint, typecheck, format, build produksi     | **Lulus**                                                     |
| WeKnora sungguhan end-to-end                | **Lulus** — 7 dokumen terindeks, sync diulang 3× tetap 7      |
| Q4 (40 gold questions, recall@5, grounding) | **BELUM DIKERJAKAN** — butuh corpus dan reviewer domain       |

**Q4 pada corpus sintetis** (`pnpm rag:eval`, 40 pertanyaan di `tests/rag/gold-questions.ts`):

| Kelompok                          | Hasil                                      |
| --------------------------------- | ------------------------------------------ |
| 20 answerable (2 multi-sumber)    | recall@5 **100%** — usulan PLAN ≥90%       |
| 10 lintas izin (termasuk injeksi) | **10/10 tanpa kebocoran**                  |
| 10 tanpa bukti                    | **0/10 abstain penuh** — lihat batas di §9 |
| Latensi retrieval                 | p50 479 ms · p95 580 ms · maks 1,1 s       |

Recall dilaporkan, bukan dijadikan gerbang: angkanya berlaku untuk fixture ini. Kebocoran nol adalah syarat mutlak, dan `pnpm rag:eval` keluar non-nol bila ada.

Bukti perilaku yang paling menentukan, diukur langsung:

| Tahap                   | Sitasi | Scope | Indeks | WeKnora |
| ----------------------- | ------ | ----- | ------ | ------- |
| awal                    | 6      | 3     | 7      | 7       |
| tepat setelah revoke    | 5      | 2     | 7      | 7       |
| setelah worker berjalan | 5      | 2     | 6      | 6       |
| setelah dipulihkan      | 6      | 3     | 7      | 7       |

Baris kedua adalah intinya: dokumen yang dicabut berhenti dikutip pada request berikutnya **walaupun record-nya masih ada di WeKnora**. Penghapusan fisik menyusul, dan bukan syarat keamanan.

`tests/rag/weknora-stub.ts` tetap dipakai untuk kasus yang tidak bisa diminta dari server sehat (crash di tengah, lease kedaluwarsa). Lulusnya suite stub bukan bukti WeKnora asli berperilaku sama — itulah sebabnya suite HTTP dan E2E dijalankan terhadap WeKnora sungguhan.

## 9. Kenyataan resource pada mesin 8 GB

Diukur pada laptop 7,7 GB RAM saat sesi ini. Profil penuh **tidak muat**: enam
container memakai sekitar 5 GB, dan `pnpm dev` mati dengan exit code 4 (OOM) ketika
semuanya hidup bersamaan.

| Yang dijalankan                    | Container                                            | Perkiraan RAM |
| ---------------------------------- | ---------------------------------------------------- | ------------- |
| Portal + reader + katalog + search | `postgres`                                           | ~0,3 GB       |
| Ditambah asisten AI                | `+ weknora-app`, `weknora-postgres`, `weknora-redis` | ~3,5 GB       |
| Ditambah unggah dokumen            | `+ clamav`, `converter`                              | ~5,3 GB       |

Pilih dua dari tiga baris itu pada mesin 8 GB. Untuk menguji unggahan:

```sh
docker compose --env-file .env.local --profile weknora stop
docker compose --env-file .env.local --profile knowledge up -d clamav converter
```

Untuk kembali menguji asisten AI, kebalikannya. Menjalankan ketiganya sekaligus
membutuhkan sekitar 12 GB agar nyaman.

Port juga perlu perhatian di Windows: rentang yang dipesan WinNAT membuat bind
gagal dengan "An attempt was made to access a socket in a way forbidden by its
access permissions". Instalasi ini memakai 55432 untuk PostgreSQL dan 47080 untuk
WeKnora karena 54329 dan 58080 masuk rentang tersebut. Periksa dengan
`netsh interface ipv4 show excludedportrange protocol=tcp` sebelum memilih port.

## 10. Batas yang belum selesai

- **Q4 belum dikerjakan.** Tidak ada 40 pertanyaan berlabel, tidak ada angka recall@5, tidak ada review grounding oleh pemilik domain. Tanpa itu kualitas jawaban belum terukur.
- **Ambang relevansi tidak bisa dipasang dengan mesin ini, dan itu terukur.** Q4 menunjukkan 0/10 abstain pada pertanyaan tanpa bukti: sumber yang cocok lemah tetap dikembalikan. Penyebabnya bukan pilihan angka yang belum dibuat, melainkan tidak adanya sinyal: `score` pada hybrid-search WeKnora selalu bernilai 0,016 — konstanta RRF 1/61 — sehingga tidak membedakan relevansi sama sekali, dan parameter `vector_threshold` berperilaku tidak monotonik saat diukur (ambang 0,0–0,7 menghasilkan 14/14/14/12/15/15/15 hit). Memasang angka di atas sinyal yang tidak ada akan menyembunyikan masalah, bukan menyelesaikannya. Yang tidak pernah terjadi: mengarang jawaban. Perbaikan yang mungkin — menghitung kemiripan sendiri memakai model embedding, lalu mengkalibrasinya terhadap 40 pertanyaan Q4 yang kini tersedia.
- **`AI_GENERATION` diuji, tetapi tidak dinyalakan secara default.** Dengan `qwen2.5:1.5b-instruct` di Ollama host, jawaban benar-benar grounded pada dokumen. Biayanya diukur: **35–42 detik per jawaban** pada laptop 7,7 GB RAM (target Q5 ≤15 detik), dan permintaan berbarengan membuatnya gagal `503` karena mesin kehabisan memori — saat pengujian hanya tersisa 0,35 GB. Karena itu default tetap `AI_GENERATION=off`: retrieval-only menjawab p95 di bawah 1 detik dan tidak pernah gagal. Untuk menyalakannya:

  ```sh
  ollama pull qwen2.5:1.5b-instruct
  # daftarkan sebagai model type=KnowledgeQA di WeKnora, lalu di .env.local:
  AI_GENERATION=weknora-local
  WEKNORA_CHAT_TIMEOUT_MS=150000   # default 60 detik terlalu ketat untuk CPU lokal
  ```

  Perangkat dengan RAM lebih besar (≥16 GB) sebaiknya memakai model yang lebih mampu; 1.5B dipilih semata karena itu yang muat di sini.

- **`WEKNORA_MAX_SCOPE_DOCUMENTS`** membatasi retrieval pada versi teraktif per actor. Cukup untuk corpus sintetis, belum untuk 1.000 dokumen pada budget Q5.
- **Sinkronisasi otomatis** berjalan di worker tiap siklus; `pnpm weknora:sync` tetap disediakan untuk memaksa satu putaran.
- **Cascade delete** pada FK RAG membuang `knowledge_id` sebelum exporter sempat menghapus record di WeKnora. Versi yang sudah disetujui bersifat immutable dan tidak pernah dihapus dalam operasi normal, jadi jalur ini hanya tersentuh oleh pembersihan test atau tindakan operator.

## 11. Auto-tag dan rerank

### Auto-tag: jalur lengkap, hasil nyata masih nol

WeKnora punya auto-tagger: sebuah model bahasa membaca isi dokumen dan menempelkan tag.
Fitur ini dinyalakan pada knowledge base IntraDocs dan **terbukti berjalan** — bukan dari
membaca kode, melainkan dari relasi tag yang benar-benar tertulis di database WeKnora.

Satu hal yang perlu dipahami sebelum menyalakannya: `AutoTagConfig` **memilih dari kosakata
tag yang sudah ada di knowledge base**, bukan mengarang istilah baru. Selama `knowledge_tags`
kosong, reparse selesai tanpa satu pun tag — itu bukan kegagalan, itu perilaku yang benar.
Kolam tag di WeKnora karena itu diisi dari label IntraDocs (9 label), sehingga pertanyaan yang
dijawab model menjadi "label kami yang mana yang cocok", bukan "istilah apa yang terpikir".

Hasil pengukuran pada 8 dokumen sintetis, model `qwen2.5:1.5b-instruct`:

| Dokumen | Kategori | Label IntraDocs | Tag model |
|---|---|---|---|
| Konfigurasi VPN | Infrastruktur & Jaringan | Runbook, Jaringan | Standar |
| Kebijakan Backup & Retensi | Data & Integrasi | Referensi, Tata Kelola | Standar |
| Standar Penamaan Repository | Aplikasi Internal | Standar | Standar |
| SOP-IT-014 Manajemen Identitas | Keamanan Informasi | Identity, SOP | SOP |
| Panduan Versi | Infrastruktur & Jaringan | — | Referensi |
| Matriks SLA, Agent Monitoring, Lampiran Rahasia | — | — | (tidak ada) |

Dibaca apa adanya: 2 dari 5 tag benar, 2 jelas salah, 3 dokumen tidak menghasilkan apa pun,
dan model tidak pernah memberi lebih dari satu tag meski `max_tags=5`. **Saran bersih yang
lolos ke IntraDocs saat ini: nol.** Dua tag yang benar sudah dimiliki versinya, dan dua yang
salah dibuang oleh penyaring kategori. Angka itu dilaporkan apa adanya; fitur ini belum
memberi nilai pada corpus ini.

Yang tetap berguna adalah **penyaringnya**, dan itulah bagian yang dibangun di IntraDocs:

- Tag adalah keluaran model yang membaca isi dokumen, jadi diperlakukan sebagai data. Sebuah
  tag hanya lolos bila namanya **sudah menjadi label pada kategori dokumen itu sendiri**.
  Kalimat di dalam dokumen tidak bisa menciptakan label — dan pada praktiknya penyaring ini
  membuang tepat dua saran yang salah di atas.
- Label yang sudah dimerge tidak pernah diusulkan, sama seperti ia tidak lagi ditawarkan untuk
  dokumen baru.
- **Tidak ada yang ditulis.** `app.protect_version()` membekukan `labels`, jadi menerima saran
  berarti membuat revisi yang disetujui reviewer. Model mengusulkan, orang memutuskan.
- Dokumen yang tidak boleh dibaca menjawab persis sama dengan dokumen yang belum terindeks
  (`available:false`), sehingga endpoint ini tidak bisa dipakai untuk menebak keberadaan
  dokumen. `tagsFor` tidak pernah dipanggil untuk dokumen yang tidak terbaca.

Endpoint `POST /api/rag/label-suggestions` (butuh `documents.upload`) dan panel "Saran label"
di halaman dokumen. Bukti: `tests/integration/label-suggestions.test.ts` (5) dan
`tests/http/label-suggestions.test.ts` (7).

Semua langkah di bawah kini satu perintah, dan perintah itu juga mencetak tabel pengukuran
di atas untuk model apa pun yang sudah ada di Ollama lokal:

```sh
ollama pull qwen2.5:3b-instruct          # atau model lain yang muat di RAM
pnpm weknora:autotag qwen2.5:3b-instruct
```

Perintah itu mendaftarkan model ke WeKnora bila belum ada, mengisi kolam tag dari label
IntraDocs, menyalakan auto-tag dengan `skip_if_tagged=false` agar putaran baru menggantikan
putusan model sebelumnya, reparse semua dokumen terindeks, lalu mencetak per dokumen: label
IntraDocs, tag pilihan model, dan mana yang akan lolos penyaring kategori. Ia tidak menulis apa
pun ke IntraDocs — tabelnya untuk menilai model sebelum ada yang mengandalkan sarannya.

**Model lebih besar belum terukur.** Percobaan `qwen2.5:3b-instruct` (1,9 GB, muat di sisa RAM
bila dev server dimatikan) gagal pada tahap unduh: registry Ollama putus dengan `i/o timeout`,
dan blob parsial 1,93 GB yang sudah terkumpul dibuang saat pull terputus, lalu percobaan ulang
diam di 0 KB/s. Itu kendala jaringan pada saat itu, bukan keputusan; perintah di atas dibuat
justru supaya percobaan itu tinggal dijalankan ulang tanpa mengulang langkah manual.

Langkah manualnya, bila ingin melakukannya lewat API langsung:

```sh
# 1. isi kolam tag dari label IntraDocs
curl -X POST "$WEKNORA_BASE_URL/api/v1/knowledge-bases/$KB/tags" -d '{"name":"Runbook"}' ...
# 2. nyalakan auto-tag pada knowledge base
curl -X PUT "$WEKNORA_BASE_URL/api/v1/knowledge-bases/$KB" \
  -d '{"name":"intradocs-synthetic","config":{"auto_tag_config":
       {"enabled":true,"max_tags":5,"model_id":"<KnowledgeQA>","skip_if_tagged":true}}}'
# 3. reparse; tag muncul ~30 detik setelah parse selesai
curl -X POST "$WEKNORA_BASE_URL/api/v1/knowledge/batch-reparse" -d '{"kb_id":"'$KB'","ids":[...]}'
```

Catatan bentuk: `auto_tag_config` **dikirim di dalam `config`** tetapi **dibaca di level atas**
respons, dan `name` wajib disertakan pada setiap PUT — tanpa itu permintaan ditolak
`Field validation for 'Name' failed`.

### Rerank: model siap, API versi ini tidak menerimanya

`xitao/bge-reranker-v2-m3` (1,16 GB) sudah ditarik dan terdaftar sebagai model `Rerank` yang
`active` di WeKnora. Reranking tetap **tidak pernah berjalan**, dan itu dibuktikan bukan dengan
membaca kode:

- hybrid-search dengan dan tanpa `rerank_model_id` mengembalikan **urutan yang identik**;
- proses "ber-rerank" justru **lebih cepat** (383 ms vs 877 ms) — mustahil bila sebuah model
  1,16 GB benar-benar dijalankan di CPU;
- log WeKnora tidak pernah mencatat pemanggilan reranker.

Penyebabnya: `rerank_model_id` milik `internal_types.RetrievalConfig`, yang dipetakan ke kolom
tabel `sessions`. `CreateSessionRequest` hanya menerima `title`/`description`, dan
`PUT /api/v1/sessions/:id` membalas `200` dengan log "Session updated successfully" sementara
kolom `rerank_model_id` di database tetap kosong — field-nya dibuang tanpa error.

Karena itu rerank dinyatakan **terblokir sampai versi WeKnora yang mengekspos field ini**.
Menulis langsung ke tabel `sessions` milik WeKnora akan membuat IntraDocs bergantung pada
skema internal produk lain, dan itu tidak dilakukan.

`summary_model_id` senasib: hanya bisa diatur saat knowledge base dibuat, sehingga mengubahnya
berarti membuat ulang knowledge base dan mengindeks ulang seluruh dokumen.

## 12. Summary dan UI WeKnora

### Summary: tidak dinyalakan, dan alasannya bukan teknis

`summary_model_id` **tidak ada** di `KnowledgeBaseConfig` — schema `UpdateKnowledgeBaseRequest`
hanya menerima `auto_tag_config`, `chunking_config`, `faq_config`, `image_processing_config`,
`indexing_strategy`, dan `wiki_config`. Field itu hanya bisa diisi saat knowledge base dibuat,
jadi mengubahnya berarti membuat KB baru dan mengindeks ulang seluruh dokumen.

Efek sampingnya terlihat di database WeKnora: setiap dokumen berstatus
`summary_status = failed`, karena summary tetap diantrikan pada setiap parse lalu berhenti di
`no_summary_model`. Biayanya kecil (gagal seketika, bukan inferensi), tetapi statusnya memang
begitu dan tidak perlu dibaca sebagai kerusakan.

Meski begitu, alasan utama summary **tidak** dinyalakan bukan kesulitan teknis di atas,
melainkan tidak adanya permukaan validasi:

- Saran label bisa diamankan karena sebuah tag dapat **dicocokkan** dengan kosakata label
  IntraDocs; tag yang salah dibuang secara mekanis, dan itu terbukti membuang dua saran salah.
- Summary adalah teks bebas. Tidak ada daftar yang bisa dipakai untuk menolaknya. Summary yang
  lancar tetapi keliru akan lolos setiap pemeriksaan yang bisa ditulis, dan ia berdiri persis
  di sebelah dokumen yang sudah disetujui reviewer — tempat pembaca paling mudah mengira itu
  kalimat dokumen itu sendiri.
- Model yang tersedia di mesin ini, `qwen2.5:1.5b-instruct`, baru saja terukur 2 dari 5 benar
  pada tugas **pilihan ganda** yang jauh lebih mudah. Keluaran teks bebasnya bukan sesuatu yang
  layak ditempelkan pada dokumen kebijakan.

Kalau nanti dinyalakan, syaratnya: model yang lebih mampu, dan summary ditampilkan sebagai
draf yang harus diadopsi lewat revisi — persis pola saran label, bukan teks yang langsung
tampil sebagai milik dokumen.

Satu hal yang **memang** dipakai dari field ini: pada permintaan chat, `summary_model_id`
berarti *model penyusun jawaban* dan bisa dipin per permintaan. Sebelumnya IntraDocs membiarkan
WeKnora memakai default tenant, sehingga model apa pun yang belakangan didaftarkan sebagai
default — termasuk model eksternal — akan diam-diam menjadi penjawab. Kini
`WEKNORA_GENERATION_MODEL_ID` memin model itu dari sisi server IntraDocs, dan untuk
`AI_GENERATION_LOCATION=external` pin ini **wajib**: default tenant WeKnora tidak boleh
menentukan ke jaringan mana sebuah pertanyaan dikirim. Generasi lokal boleh tanpa pin.
Bukti: `tests/unit/weknora.test.ts` ("the answering model is pinned…") dan
`tests/unit/core.test.ts` ("external generation is refused…").

### UI WeKnora: alat operator, bukan pintu kedua ke korpus

WeKnora punya frontend sendiri (`wechatopenai/weknora-ui`). Ia **tidak** dijalankan oleh profil
`weknora`, melainkan profil terpisah `weknora-ui` yang harus diminta secara sadar:

```sh
docker compose --env-file .env.local --profile weknora --profile weknora-ui up -d weknora-ui
# http://127.0.0.1:47081  (loopback saja, seperti API)
```

Dua profil diperlukan karena UI bergantung pada backend; menyebut satu profil saja membuat
dependensinya tidak terdefinisi. Image UI membawa nginx dengan upstream `app` yang di-hardcode,
jadi `weknora-app` diberi alias jaringan `app` — bukan dengan mengubah image orang lain.

Alasan ia tidak boleh jadi permukaan pengguna sudah diuji, bukan diperkirakan. Dengan akun
layanan dari `var/weknora-service.json`, login ke UI lalu `switch-tenant` ke workspace IntraDocs
mengembalikan **"Lampiran Simulasi Keamanan — Rahasia"** secara utuh — dokumen yang di IntraDocs
memerlukan grant eksplisit. WeKnora menegakkan batas tenant miliknya sendiri dan tidak tahu apa
itu klasifikasi, status persetujuan, scope kategori, atau grant. Itulah tepatnya mengapa
IntraDocs berdiri di depan sebagai gerbang kebijakan, dan mengapa UI ini hanya berguna untuk
satu pekerjaan: melihat apa yang sebenarnya terindeks ketika retrieval berperilaku aneh.

Yang membatasi siapa yang bisa masuk adalah pendaftaran yang kini tertutup — lihat di bawah.

### Registrasi WeKnora ditutup oleh setup, bukan oleh checklist

`pnpm weknora:setup` sebelumnya hanya **mencetak** langkah "set WEKNORA_DISABLE_REGISTRATION=true
lalu restart profil". Pada mesin ini langkah itu tidak pernah dijalankan, dan WeKnora melaporkan
`registration_mode: self_serve` — siapa pun yang menjangkau port loopback bisa membuat tenant
sendiri beserta API key-nya, yaitu pintu kedua ke index yang tidak dikendalikan IntraDocs.

Checklist bukan penjaga. Sekarang setup menutup pintu itu sendiri: menulis flag, membuat ulang
container yang membacanya, lalu **memverifikasi ke WeKnora** bahwa `registration_mode` bukan lagi
`self_serve` dan gagal keras bila masih. Setelah perbaikan, instance ini melaporkan
`registration_mode: invite_only`, sehingga satu-satunya akun yang dapat masuk — termasuk lewat
UI — adalah akun layanan yang filenya gitignored dan hanya ada di mesin ini.

## 13. Wiki, Langfuse, unggah berkas, dan fitur WeKnora lainnya

### Aturan umum yang membuat semuanya aman: rekaman tanpa versi IntraDocs tidak bisa dikutip

Sebelum menimbang fitur satu per satu, satu properti menentukan seluruh jawabannya. Kutipan
divalidasi ulang ke IntraDocs lewat `knowledge_id`. Rekaman WeKnora yang tidak punya baris di
`app.rag_index_entries` tidak menghasilkan apa pun — apa pun isinya, dan sebagus apa pun ia
cocok dengan pertanyaan.

Ini diuji, bukan disimpulkan (`tests/http/weknora-side-content.test.ts`). Sebuah rekaman ditanam
langsung di WeKnora berisi kata yang tidak ada di seluruh korpus, lalu:

1. dibuktikan **benar-benar terindeks dan tercari** di WeKnora — tanpa langkah ini tiga tes
   berikutnya akan lulus karena alasan yang salah;
2. dipastikan tidak punya baris di `app.rag_index_entries`;
3. ditanya lewat `/api/rag/search` — tidak pernah muncul sebagai kutipan;
4. ditanya lewat `/api/rag/chat` — katanya tidak muncul di **mana pun** dalam respons.

Arah sebaliknya juga aman: orphan sweep hanya menghapus rekaman yang membawa penanda judul
milik exporter IntraDocs. Halaman wiki, entri FAQ, atau berkas yang diunggah operator dibiarkan
utuh. Keduanya bisa hidup berdampingan tanpa saling merusak.

Konsekuensinya untuk setiap fitur di bawah: **tidak satu pun bisa membocorkan sesuatu ke
pengguna IntraDocs** — dan justru karena itu, tidak satu pun bisa menambah nilai pada retrieval.
Nilai hanya masuk lewat dokumen yang diekspor IntraDocs.

### Wiki: mati, dan bukan karena hemat CPU saja

Pipeline wiki adalah Map/Reduce berbasis LLM: per dokumen ia mengekstrak entitas, menulis
ringkasan, dan mengutip chunk (`ingest_map_parallel`, default 10 paralel), lalu menulis halaman
per slug (`ingest_reduce_parallel`). Keluarannya adalah prosa yang **disintesis lintas dokumen**.

Di mesin yang butuh 35–42 detik untuk satu jawaban 1.5B, biaya itu saja sudah menutup pintu.
Tetapi alasan yang lebih penting: halaman wiki tidak punya versi IntraDocs di belakangnya,
sehingga menurut aturan di atas ia **tidak akan pernah bisa dikutip**. Jadi wiki akan membakar
CPU untuk menghasilkan teks yang tidak pernah sampai ke siapa pun — sambil menggabungkan isi
dokumen terbatas dan publik ke dalam satu halaman. Gerbang IntraDocs menahannya, tetapi
membuat bahan yang harus ditahan bukan desain yang baik.

Tetap mati: `indexing_strategy.wiki_enabled=false` (dan `graph_enabled=false`), sebagaimana
diatur `pnpm weknora:setup`.

### Langfuse: didukung WeKnora, dan justru karena itu berbahaya secara default

WeKnora punya dukungan Langfuse bawaan — `LANGFUSE_ENABLED`, `LANGFUSE_HOST`,
`LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_SAMPLE_RATE`, dan seterusnya. Yang
dikirimkannya bukan metrik agregat: nama-nama internalnya menyebut `LangfuseMessages`,
`LangfuseGenerationOutput`, `LangfuseToolCalls` — yaitu **prompt, potongan dokumen, dan keluaran
model**.

Kegunaannya nyata dan tidak dilebih-lebihkan: pertanyaan "apakah reranker benar-benar
dipanggil" yang butuh pengukuran waktu dan pembacaan log akan terjawab dalam hitungan detik
oleh trace. Tetapi mengarahkan `LANGFUSE_HOST` ke layanan cloud berarti mengirim pertanyaan
pengguna dan isi dokumen ke luar mesin — persis yang dilarang brief. Karena itu:

- **tidak dinyalakan secara default**, dan tidak disediakan jalan pintas untuk menyalakannya;
- kalau dipakai, hanya Langfuse **self-hosted** di jaringan yang sama;
- di mesin ini itu tidak mungkin: Langfuse v3 membawa Postgres, ClickHouse, Redis, dan MinIO
  sendiri, sementara profil WeKnora sudah memakai ~5 GB dari 7,7 GB.

Sampai ada mesin yang muat, observability M4 tetap bersandar pada `pnpm weknora:status`, tabel
`app.rag_audit`, dan log WeKnora — semuanya tinggal di mesin ini.

### Unggah berkas ke WeKnora: bisa, bahkan PDF — tetapi bukan jalur ingest yang benar

Diuji langsung: `POST /knowledge-bases/{id}/knowledge/file` menerima berkas dan
menyelesaikannya. `.txt` terurai, dan **PDF pun terurai dengan benar** menjadi chunk berisi
teksnya — padahal `DOCREADER_ADDR` tidak diset sama sekali, jadi parser in-process WeKnora
sudah cukup untuk kasus ini. (Format lain — PPTX, DOC lama, gambar ber-OCR — belum diuji di
sini dan kemungkinan besar memang memerlukan layanan `docreader` terpisah.)

Meski begitu, mengirim berkas asli ke WeKnora **tidak** diadopsi sebagai jalur ingest, karena
satu alasan yang tidak bisa ditawar: yang disetujui reviewer adalah Markdown kanonik IntraDocs.
Kalau WeKnora mengurai berkas aslinya sendiri, teks yang terindeks adalah teks yang **tidak
pernah dilihat siapa pun saat approval**, dan retrieval akan mengutip kalimat yang tidak pernah
disetujui. Tambahan lagi, salinan kedua byte asli akan mengendap di volume WeKnora — di luar
gerbang kebijakan, di luar retensi dan penghapusan IntraDocs.

Yang justru berguna dari temuan ini adalah petunjuk untuk S05 (PPTX/OCR/DOC lama/ZIP yang masih
tertunda): parser WeKnora bisa dipakai untuk **menghasilkan Markdown kanonik**, yang lalu masuk
alur unggah–scan–review IntraDocs seperti berkas lain. Dengan begitu kemampuan parsingnya
terpakai tanpa merusak invarian "yang terindeks adalah yang disetujui".

### FAQ dan sisanya

`faq_config`, `question_generation_config`, ASR, dan VLM masuk kelas yang sama: keluarannya
lahir di sisi WeKnora, tidak punya versi IntraDocs, karena itu tidak bisa dikutip. Semuanya
tetap mati, dan menyalakannya hanya masuk akal bila hasilnya dibawa kembali ke IntraDocs
sebagai **saran yang diadopsi lewat revisi** — pola yang sama seperti saran label pada §11.
