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

Dua hal yang baru terlihat pada checkout benar-benar bersih (laptop kedua, September 2026):

- `setup:local` kini ikut membuat `WEKNORA_DB_PASSWORD`, `WEKNORA_REDIS_PASSWORD`, `WEKNORA_JWT_SECRET`, dan `WEKNORA_AES_KEY`. Compose v5 menginterpolasi semua service di `compose.yaml`, termasuk yang di balik profil `weknora`, sehingga `up -d postgres` gagal bila keempatnya belum ada. `weknora:setup` tidak menimpa nilai yang sudah ada.
- `seed` mengisi `app.labels` dari label dokumen. Migrasi 006 hanya melakukannya untuk dokumen yang ada saat migrasi; pada checkout baru migrasi berjalan sebelum seed, sehingga kolam auto-tag dan saran label kosong.

**Dua checkout di satu mesin** (mis. git worktree): `compose.yaml` memakai nama proyek tetap `intradocs-local`, jadi checkout kedua akan menabrak volume dan port checkout pertama. Pada run pertama saja:

```sh
COMPOSE_PROJECT_NAME=intradocs-wt-<nama> POSTGRES_PORT=54330 pnpm setup:local
```

lalu di `.env.local` sebelum `weknora:setup`: `CLAMAV_PORT`, `KNOWLEDGE_PORT`, `WEKNORA_PORT`, `WEKNORA_UI_PORT` yang tidak bentrok, dan `APP_URL=http://localhost:3001` bila `:3000` sudah dipakai. Nilai-nilai itu dibaca Compose dan skrip dari `.env.local` pada setiap panggilan berikutnya.

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
| `WEKNORA_MIN_RELEVANCE`       | 0.45    | Kemiripan minimum agar dikutip; 0 mematikan gerbang (§14)     |
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
| `503` pada retrieval; log WeKnora: `assertion failed: item_pointer_is_valid(ctid)` (SQLSTATE XX000) | Index BM25 ParadeDB rusak setelah penghapusan massal (mis. KB lama saat `weknora:reindex`). `docker compose --env-file .env.local --profile weknora exec weknora-postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "REINDEX INDEX embeddings_search_idx"'`; `weknora:reindex` kini melakukannya sendiri |
| `bind: An attempt was made to access a socket in a way forbidden` | Port masuk rentang cadangan WinNAT. `netsh interface ipv4 show excludedportrange protocol=tcp`, lalu pilih port di luar rentang itu |
| `converter_unavailable` saat unggah | Jaringan `conversion` harus `internal: false` selama worker berjalan di host; port internal tidak dapat dipublikasikan |

Log yang aman dibagikan: `pnpm weknora:status` dan baris audit `rag.*` di `app.audit_events`. Keduanya tidak memuat key, pertanyaan, atau isi dokumen.

## 8. Status gate

Dijalankan pada RC M1–M3 dengan profil `weknora` hidup, PostgreSQL lokal, dan Ollama `bge-m3` di host.

| Gate                                                       | Hasil                                                                                                                                                 |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit                                                       | **266 lulus**, 0 gagal, 3 skip                                                                                                                        |
| Konten (render Markdown)                                   | **3 lulus** — sebelumnya gagal impor `react`, kini diperbaiki                                                                                         |
| Integrasi PostgreSQL/RLS                                   | **52 lulus**, 0 gagal                                                                                                                                 |
| HTTP (RAG, saran label, akses, bacaan wajib, cabut massal) | **47 lulus**, 0 gagal; suite unggah butuh profil `knowledge` yang tidak muat bersama WeKnora di 8 GB                                                  |
| E2E browser desktop + mobile                               | **14 lulus** (satu uji portal sempat timeout saat run penuh 12 menit berjalan bersamaan dengan generasi LLM di CPU; lulus 3,9 s saat diulang sendiri) |
| Lint, typecheck, format, build produksi                    | **Lulus**                                                                                                                                             |
| WeKnora sungguhan end-to-end                               | **Lulus** — 7 dokumen terindeks, sync diulang 3× tetap 7                                                                                              |
| Q4 (40 gold questions, recall@5, grounding)                | **Dijalankan pada corpus sintetis** (tabel di bawah); review grounding oleh pemilik domain masih terbuka                                              |

**Q4 pada corpus sintetis** (`pnpm rag:eval`, 40 pertanyaan di `tests/rag/gold-questions.ts`):

| Kelompok                          | Hasil                                                                  |
| --------------------------------- | ---------------------------------------------------------------------- |
| 20 answerable (2 multi-sumber)    | recall@5 **100%** — usulan PLAN ≥90%                                   |
| 10 lintas izin (termasuk injeksi) | **10/10 tanpa kebocoran**                                              |
| 10 tanpa bukti                    | **8/10 abstain penuh** dengan gerbang relevansi (§14); sebelumnya 0/10 |
| Latensi retrieval                 | p50 569 ms · p95 720 ms · maks 853 ms (dua panggilan paralel)          |

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

- **Q4 dijalankan pada corpus sintetis, bukan pada corpus nyata.** 40 pertanyaan berlabel, recall@5 dan abstain terukur (§8). Yang belum ada: review grounding jawaban oleh pemilik domain pada dokumen sungguhan — dan itu memang tidak bisa dilakukan dengan data sintetis.
- **Ambang relevansi — dulu dinyatakan mustahil, ternyata keliru; lihat §14.** Klaim lama bahwa `score` hybrid-search selalu 0,016 benar hanya ketika hasil keyword dan vektor difusi (RRF). Dengan `disable_keywords_match=true` WeKnora mengembalikan kemiripan kosinus asli, terbatas `knowledge_ids`. Gerbangnya kini terpasang, dikalibrasi pada Q4, dan menaikkan abstain dari 0/10 menjadi 8/10 tanpa menurunkan recall. Yang tidak pernah terjadi tetap sama: mengarang jawaban.
- **`AI_GENERATION` diuji, tetapi tidak dinyalakan secara default.** Dengan `qwen2.5:1.5b-instruct` di Ollama host, jawaban benar-benar grounded pada dokumen. Biayanya bergantung mesin: **35–42 detik per jawaban** pada laptop 7,7 GB RAM tanpa GPU (target Q5 ≤15 detik), permintaan berbarengan gagal `503` karena kehabisan memori; pada laptop kedua dengan GPU 6 GB, **2,4 detik hangat / 19 detik dingin**. Karena itu default tetap `AI_GENERATION=off`: retrieval-only menjawab p95 di bawah 1 detik dan tidak pernah gagal. Untuk menyalakannya:

  ```sh
  ollama pull qwen2.5:1.5b-instruct
  pnpm weknora:generation qwen2.5:1.5b-instruct   # turunan ber-num_predict, daftar, pin, agen
  # lalu di .env.local:
  AI_GENERATION=weknora-local
  WEKNORA_CHAT_TIMEOUT_MS=150000   # default 60 detik terlalu ketat untuk CPU lokal
  ```

  **Jangan mendaftarkan model Ollama telanjang sebagai penjawab.** Ditemukan saat pengujian: model 1.5B sesekali tidak berhenti — satu jawaban tercatat `completion_tokens=40960` (batas konteks digeser terus), **7–15 menit** di GPU, dan karena Ollama melayani satu permintaan per model secara berurutan, setiap permintaan berikutnya mengantre di belakangnya sampai `WEKNORA_CHAT_TIMEOUT_MS` habis dan menjadi `503`. `max_completion_tokens` pada agen WeKnora **disimpan tetapi tidak diteruskan** ke `/api/chat` Ollama sebagai `num_predict`. Yang bekerja adalah menaruh batas itu pada modelnya: `weknora:generation` membuat turunan `<model>-intradocs` lewat `POST /api/create` dengan `num_predict 1024` dan `repeat_penalty 1.15`, memverifikasi lewat `/api/show`, mendaftarkannya sebagai model `KnowledgeQA` lokal, menulis `WEKNORA_GENERATION_MODEL_ID`, lalu memin agen. Setelah itu tiga pertanyaan berturut-turut terjawab 18,9 s (dingin), 2,4 s, 2,4 s, dan `tests/http/rag.test.ts` (13) lulus termasuk dua tes yang butuh generasi.

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

| Dokumen                                         | Kategori                 | Label IntraDocs        | Tag model   |
| ----------------------------------------------- | ------------------------ | ---------------------- | ----------- |
| Konfigurasi VPN                                 | Infrastruktur & Jaringan | Runbook, Jaringan      | Standar     |
| Kebijakan Backup & Retensi                      | Data & Integrasi         | Referensi, Tata Kelola | Standar     |
| Standar Penamaan Repository                     | Aplikasi Internal        | Standar                | Standar     |
| SOP-IT-014 Manajemen Identitas                  | Keamanan Informasi       | Identity, SOP          | SOP         |
| Panduan Versi                                   | Infrastruktur & Jaringan | —                      | Referensi   |
| Matriks SLA, Agent Monitoring, Lampiran Rahasia | —                        | —                      | (tidak ada) |

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

Baseline `qwen2.5:1.5b-instruct` lewat perintah itu (7 dokumen terindeks, `skip_if_tagged=false`):
3 tag cocok label yang ada, 4 tidak cocok (semuanya `Standar`/`Tata Kelola` di kategori yang
tidak memilikinya), 2 dokumen tanpa tag, **0 saran baru lolos**. Angka pembanding untuk model
berikutnya.

Diulang pada laptop kedua (12 September 2026, kolam 9 label unik setelah perbaikan seed §3,
GPU): 2 tag cocok (`SOP`, `Standar`), 2 tidak cocok (`Tata Kelola` pada Konfigurasi VPN dan
pada Lampiran Rahasia), 3 dokumen tanpa tag, **0 saran baru lolos**. Konsisten dengan baseline;
bukan soal mesin. Catatan metode: run pertama di mesin itu berjalan saat `app.labels` masih
kosong dan menghasilkan 7 dokumen tanpa tag — angka itu mengukur kolam yang kosong, bukan
model, dan tidak dipakai.

**Model lebih besar, terukur** (`qwen2.5:3b-instruct`, 1,9 GB, dijalankan dengan dev server
dimatikan agar muat di RAM; kolam tag sama, semua keterikatan lama dilepas dulu):

|                                     | 1.5B | 3B    |
| ----------------------------------- | ---- | ----- |
| tag cocok label yang ada            | 3    | **5** |
| tag tidak cocok                     | 4    | 10    |
| dokumen tanpa tag                   | 2    | **0** |
| saran baru lolos penyaring kategori | 0    | **2** |

3B menangkap label yang benar lebih sering — SOP-IT-014 → _Identity, SOP_ persis; Lampiran
Rahasia → _Kritikal_ persis; VPN → _Runbook_ — tetapi menebak jauh lebih banyak (Standar
Penamaan diberi lima tag, tak satu pun benar). Dua saran yang lolos, keduanya untuk Kebijakan
Backup: _Kritikal_ (masuk akal) dan _Runbook_ (bukan). Penyaring kategori membuang 8 tebakan
lainnya. Kesimpulan desain tidak berubah: saran, bukan keputusan; dan 3B adalah model yang
layak dipakai untuk fitur ini bila RAM mengizinkan, 1.5B tidak.

Catatan implementasi: WeKnora **menolak menghapus tag yang masih terikat** (`400 标签仍有知识…`),
jadi perintah ini tidak membangun ulang kolam; ia melepas semua keterikatan lewat
`PUT /api/v1/knowledge/tags` dengan `updates` berbentuk peta `knowledge_id → [tag_id]`.

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

### Rerank: knob-nya ada di agen; yang tidak ada adalah server reranker-nya

Diagnosis sebelumnya ("API versi ini membuang `rerank_model_id`") benar untuk `sessions` dan
tenant, tetapi tidak lengkap. Field itu **diterima dan disimpan pada agen** (`POST/PUT
/api/v1/agents`), dan `pnpm weknora:agent` kini memin agen `intradocs-portal` dengan semua
kemampuan opsional mati — web search, query rewrite, tools, MCP, skills, FAQ boosting, saran —
model penjawab dipin, fallback tetap ("tidak tahu"), dan `WEKNORA_RERANK_MODEL_ID` bila diisi.
Skrip membaca ulang konfigurasi tersimpan dan gagal keras bila WeKnora menyimpan sesuatu yang
seharusnya mati atau membuang `rerank_model_id`.

Yang menghentikan rerank adalah lapisan di bawahnya, dan itu diuji lewat
`POST /api/v1/initialization/rerank/check`: WeKnora memanggil `{baseUrl}/rerank` (gaya
TEI/Jina), dan **Ollama menjawab 404** untuk `/rerank`, `/api/rerank`, maupun `/v1/rerank`
(Ollama 0.34.0 tidak menyediakan API rerank). Jadi model `xitao/bge-reranker-v2-m3` yang
terdaftar sebelumnya tidak pernah bisa dipanggil — bukan karena konfigurasi, melainkan karena
tidak ada server yang melayaninya. Percobaan "dengan vs tanpa rerank" yang urutannya identik dan
justru lebih cepat kini punya penjelasan lengkap.

Untuk menyalakannya nanti dibutuhkan server reranker terpisah (mis. `text-embeddings-inference`
dengan `BAAI/bge-reranker-v2-m3`, ±1,2 GB RAM), didaftarkan sebagai model `Rerank` dengan
`base_url` server itu, lalu `WEKNORA_RERANK_MODEL_ID=<id>` dan `pnpm weknora:agent`. Pada mesin
7,7 GB ini ia tidak muat bersama portal dan model penjawab, jadi tidak dijalankan.

`summary_model_id` senasib: hanya bisa diatur saat knowledge base dibuat, sehingga mengubahnya
berarti membuat ulang knowledge base dan mengindeks ulang seluruh dokumen.

## 12. Summary dan UI WeKnora

### Summary: tidak dinyalakan, dan alasannya bukan teknis

> **Diperbarui 12 September 2026 — lihat §17.** Summary dan question generation kini menyala
> pada knowledge base produksi lewat `pnpm weknora:reindex`, dengan permukaan validasi yang
> dulu belum ada: summary hanya tampil kepada orang yang boleh merevisi, sebagai draf, dan
> tidak pernah kepada pembaca. Analisis di bawah tetap benar tentang _mengapa_ ia tidak boleh
> tampil sebagai teks dokumen.

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
berarti _model penyusun jawaban_ dan bisa dipin per permintaan. Sebelumnya IntraDocs membiarkan
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

## 14. Gerbang relevansi: sinyal yang ternyata ada

Sampai sebelum bagian ini, dokumen ini menyatakan ambang relevansi tidak mungkin dipasang karena
`score` hybrid-search selalu 0,016. Pernyataan itu **keliru sebagian**, dan koreksinya dicatat di
sini apa adanya.

Yang benar: nilai 0,016 adalah konstanta RRF (1/61) yang muncul **hanya ketika hasil keyword dan
vektor difusi**. Pada instance ini mesin keyword (ParadeDB) praktis tidak mengembalikan apa pun
untuk kueri berbahasa Indonesia, sehingga sebagian besar respons sebenarnya sudah membawa skor
vektor asli — tetapi semantiknya berubah-ubah antar kueri, dan itulah yang membuat percobaan
`vector_threshold` dulu terlihat tidak monotonik. Cara mendapatkan skor yang **konsisten**:
panggil hybrid-search kedua kalinya dengan `disable_keywords_match=true`, dalam scope
`knowledge_ids` yang sama. Respons itu berisi kemiripan kosinus bge-m3 per chunk.

(`/api/v1/knowledge-search` juga mengembalikan skor asli, tetapi **mengabaikan `knowledge_ids`**
— diuji: dua ID diminta, tujuh dokumen kembali — sehingga tidak dipakai untuk apa pun.)

### Cara kerja `gateByRelevance` (`packages/core/src/rag.ts`)

1. Dua panggilan paralel dalam scope actor: fusi (untuk recall) dan vektor-saja (untuk skor).
   Latensi p95 tidak berubah (720 ms vs 786 ms sebelumnya).
2. Kandidat fusi dipertahankan bila kemiripannya ≥ `WEKNORA_MIN_RELEVANCE`, **atau** ia adalah
   exact keyword match (`match_type=1`). Chunk konteks (`match_type` 2/4/5 — tetangga, parent,
   relasi) tidak pernah dihitung sebagai bukti.
3. Hit vektor yang terlewat oleh fusi ditambahkan bila lolos ambang; hasil diurutkan menurut
   kemiripan.
4. Kosong berarti abstain. Otorisasi **tidak** diputuskan di sini — `validateRetrieval` tetap
   berjalan sesudahnya, pada setiap hit yang lolos.
5. `WEKNORA_MIN_RELEVANCE=0` mematikan gerbang dan mengembalikan perilaku lama persis.

### Kalibrasi pada Q4 (`pnpm rag:eval`, server di-restart per titik)

| Ambang             | recall@5 (20 answerable) | abstain (10 tanpa bukti) | Catatan                                                             |
| ------------------ | ------------------------ | ------------------------ | ------------------------------------------------------------------- |
| 0 (mati)           | 20/20                    | 0/10                     | keadaan sebelumnya                                                  |
| **0,45 (default)** | **20/20**                | **8/10**                 | n06 (0,458 → VPN), n10 (0,522 → kebijakan backup aktif) masih lolos |
| 0,48               | 19/20                    | 9/10                     | a20 (dua sumber) kehilangan sumber keduanya                         |
| 0,52               | 15/20                    | 9/10                     | a10, a13, a16 abstain padahal terjawab                              |

Distribusi mentahnya: pertanyaan terjawab memiliki skor terbaik 0,491–0,766 (median ≈0,59);
pertanyaan tanpa bukti 0,314–0,522 (7 dari 10 di bawah 0,40). Kedua kelompok **bertumpang
tindih di 0,45–0,52**, jadi tidak ada angka yang memisahkan sempurna; 0,45 dipilih karena salah
abstain (pengguna diberi "tidak tahu" untuk pertanyaan yang sebenarnya terjawab) lebih merugikan
daripada menampilkan sumber lemah tanpa jawaban. Dua kasus yang tersisa memang "berdekatan
secara sah": n10 menanyakan kebijakan retensi lama, dan yang dikembalikan adalah kebijakan
retensi yang berlaku.

Angka ini milik corpus fixture. Untuk corpus nyata, jalankan `pnpm rag:eval` dengan gold set
milik domain itu sebelum mengubah ambang.

### Satu hal yang ditemukan sambil jalan

`pnpm dev` meneruskan env ke proses web lewat **allowlist eksplisit** (`scripts/runtime-env.ts`).
`WEKNORA_MIN_RELEVANCE`, `WEKNORA_GENERATION_MODEL_ID`, `AI_GENERATION_LOCATION`, dan
`AI_EXTERNAL_ACKNOWLEDGED` semula tidak ada di dalamnya — sehingga tiga titik kalibrasi pertama
diam-diam berjalan pada default, dan pengaturan generasi eksternal tidak pernah sampai ke server
web (gagal-aman ke `local`, tetapi peringatan di UI juga tidak muncul). Keempatnya kini
diteruskan, dan `tests/unit/core.test.ts` memastikan setiap setelan yang dipahami `readAiConfig`
benar-benar sampai ke proses web.

## 15. Lab: mencoba semua fitur ingest WeKnora tanpa menyentuh gerbang kebijakan

Summary hanya bisa diatur saat knowledge base dibuat; question generation, auto-tag dan wiki
membakar inferensi pada setiap ingest. Mengubah knowledge base yang dibaca portal demi mencoba
semua itu berarti mengubah perilaku produksi untuk sebuah eksperimen. Jalan tengahnya:

```sh
pnpm weknora:lab            # + --wiki bila ingin pipeline wiki (Map/Reduce, berat di CPU)
docker compose --env-file .env.local --profile weknora --profile weknora-ui up -d weknora-ui
# http://127.0.0.1:47081 → login akun layanan (var/weknora-service.json) → knowledge base "intradocs-lab"
```

`weknora:lab` membuat knowledge base kedua, **`intradocs-lab`**, dengan `summary_model_id`,
`question_generation_config` (3 pertanyaan per chunk) dan `auto_tag_config` menyala sejak
dibuat — diverifikasi tersimpan lewat `GET /knowledge-bases/:id` — lalu mengisinya dengan
**versi yang sama persis** yang sudah diindeks produksi (`app.rag_index_entries`), sehingga
aturan kelayakan exporter (disetujui, terbit, tidak dicabut, tidak kedaluwarsa) ikut terbawa.
Kolam tag disalin dari label IntraDocs. ID-nya ditulis ke `.env.local` sebagai
`WEKNORA_LAB_KNOWLEDGE_BASE_ID`; `readAiConfig` **tidak mengenal kunci itu**, jadi portal tidak
mungkin membacanya tanpa perubahan kode.

Di UI WeKnora Anda bisa: mengobrol dengan knowledge base lab memakai chat bawaan WeKnora
(riwayat, query rewrite, saran pertanyaan lanjutan — semua yang dimatikan di agen portal),
melihat summary per dokumen, pertanyaan yang dihasilkan per chunk, tag otomatis, mengunggah
berkas (PDF/DOCX) langsung, dan bila `--wiki` dipakai, halaman wiki hasil sintesis lintas
dokumen.

Batasnya tegas dan tidak bisa dinegosiasikan oleh UI: knowledge base ini hanya boleh berisi
corpus sintetis, karena UI menampilkan seluruh isinya tanpa klasifikasi, scope, atau grant.
Registrasi WeKnora tertutup, jadi satu-satunya akun yang bisa masuk adalah akun layanan lokal.
Apa pun yang terbukti berguna di lab dan **punya permukaan validasi** di IntraDocs (seperti
tag → label) dipindahkan ke portal dengan pola yang sama: model mengusulkan, orang memutuskan.

## 16. Asisten: cakupan dan riwayat (S09)

Mockup S09 memuat tiga hal yang sampai September 2026 belum ada di portal: pemilih ruang
lingkup jawaban, riwayat percakapan, dan pertanyaan lanjutan dalam satu utas. Ketiganya kini
ada, dengan batas yang sama seperti retrieval itu sendiri.

**Cakupan mempersempit, tidak pernah memperluas.** Body `POST /api/rag/chat` dan
`/api/rag/search` menerima `scope` bertipe ketat — `{type:'all'}`,
`{type:'category',categoryId}` (termasuk sub-kategorinya), atau
`{type:'documents',documentIds}` (maksimal 20, diambil dari `app.read_history` milik actor)
— dan `conversationId` milik sendiri. Field lain tetap ditolak `400`. Cakupan menjadi `WHERE`
tambahan pada `listAuthorizedSources`, di atas baris yang sudah disaring RLS: kategori atau
dokumen di luar akses actor menghasilkan nol baris, yang tidak bisa dibedakan dari kategori
kosong — permintaan abstain dan tidak belajar apa pun. Bukti: `tests/http/rag.test.ts`
("a scope narrows retrieval and cannot reach a category outside the actor").

**Riwayat disimpan di IntraDocs, bukan di WeKnora.** Sesi WeKnora tetap dibuat dan dihapus
per giliran; tidak ada yang menumpuk di sana. Migrasi 029 menambah `app.ai_conversations`,
`app.ai_turns`, `app.ai_turn_citations` dengan RLS: percakapan hanya terbaca pemiliknya
(super admin pun mendapat `404`), dan sitasi tersimpan hanya terbaca selama
`app.can_read_version` masih benar untuk versinya. Bila sebuah sumber tidak lagi boleh dibaca,
sitasinya hilang dari jawaban lama dan **teks jawabannya ikut disembunyikan** — ia disusun dari
potongan yang kini tersembunyi — dengan keterangan berapa sumber yang tertutup. Endpoint:
`GET /api/rag/conversations`, `GET|DELETE /api/rag/conversations/:id`. Bukti: tes "history
belongs to its owner and loses citations when access does".

**Pertanyaan lanjutan tidak membawa konteks ke retrieval.** Setiap giliran mencari ulang dari
dokumen; jawaban sebelumnya tidak pernah menjadi masukan giliran berikutnya. Ini sengaja:
perubahan izin berlaku pada pesan berikutnya, dan agen portal tetap `multi_turn_enabled=false`.
Yang "lanjutan" adalah utasnya di layar dan di riwayat, bukan memori model.

**Halaman pencarian (S02)** kini memakai separuh retrieval yang sama: kartu "Sumber yang relevan
menurut AI" memanggil `/api/rag/search` (tanpa generasi, tanpa penyimpanan) di atas hasil
lexical, mengikuti filter kategori halaman itu, dan menautkan ke asisten dengan pertanyaan
terisi — tidak terkirim otomatis, karena generasi lokal itu lambat dan orang yang memutuskan.
Pada pertanyaan bahasa alami, lexical sering nol hasil sementara kartu itu menemukan sumbernya;
itulah alasan mockup menaruhnya di sana.

## 17. Summary, pertanyaan, dan bahasa: ingest yang dimanfaatkan sebagai saran

Tiga fitur ingest WeKnora yang dulu mati kini dipakai — dengan aturan yang sama seperti saran
label: **model mengusulkan, orang memutuskan, dan tidak ada yang bisa dikutip tanpa versi
IntraDocs.**

### `pnpm weknora:reindex`

`summary_model_id` hanya bisa diset saat knowledge base dibuat, jadi KB produksi dibuat ulang:
KB baru dengan `summary_model_id`, `question_generation_config` (3 pertanyaan per chunk) dan
`auto_tag_config` memakai model penjawab yang sudah dipin (`WEKNORA_GENERATION_MODEL_ID`);
kolam tag disalin; tabel pemetaan dikosongkan; `WEKNORA_KNOWLEDGE_BASE_ID` dipindah; exporter
mengisi ulang lewat jalur normalnya (setiap versi tetap lewat aturan kelayakan); agen dipin ke
KB baru; KB lama dihapus terakhir. Skrip menolak jalan bila worker masih hidup (heartbeat
`app.worker_status` < 90 detik), karena worker memegang ID KB lama di prosesnya. Pada 7 versi
sintetis seluruhnya selesai dalam ±1 menit; summary + pertanyaan + tag dihitung di latar ±1
menit lagi di GPU.

### Bahasa: `WEKNORA_LANGUAGE` adalah nama bahasa, bukan tag

Putaran pertama menghasilkan pertanyaan **berbahasa Mandarin**. Sumbernya
(`internal/middleware/language.go`): bahasa untuk teks yang dihasilkan diambil dari env
`WEKNORA_LANGUAGE`, lalu header `Accept-Language`, lalu hardcoded `zh-CN`. Peta lokalnya hanya
mengenal zh/en/ko/ja/ru/fr/de/es/pt; nilai lain **dimasukkan apa adanya** ke prompt
("Generate questions in {{language}}"), sehingga `id-ID` menghasilkan bahasa Inggris.
`compose.yaml` kini menyetel `WEKNORA_LANGUAGE=Indonesian` (nama, bukan tag) dan client
mengirim `Accept-Language: Indonesian`. Setelah reparse, pertanyaan konsisten berbahasa
Indonesia; summary masih campur — itu batas model 1.5B, bukan konfigurasi.

### Apa yang dihasilkan, dan siapa yang melihatnya

Hasil dibaca dari WeKnora (`GET /knowledge/:id` → `description` dan `summary_status`;
`GET /chunks/:id` → `metadata.generated_questions`) lewat `WeknoraClient.knowledgeGenerated`,
dibatasi panjangnya, dan **tidak pernah disimpan** di IntraDocs.

| Keluaran               | Kualitas terukur (qwen 1.5B, 7 dokumen)                                                            | Siapa yang melihat                                             | Bentuk                                                                                                                                |
| ---------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Pertanyaan per chunk   | Relevan dan berbahasa Indonesia pada 7/7; 1–2 per dokumen agak dangkal ("Apa tujuan dokumen ini?") | Semua pembaca dokumen itu                                      | Tautan "Tanya asisten tentang dokumen ini" → asisten dengan pertanyaan terisi dan cakupan dokumen itu; jawabannya tetap lewat gerbang |
| Pertanyaan per cakupan | idem                                                                                               | Pengguna asisten, hanya untuk versi dalam cakupan yang dipilih | Starter menggantikan contoh statis bila cakupan dipersempit                                                                           |
| Summary                | 4/7 layak sebagai draf; 2/7 "No textual content was extractable" (salah); 1/7 berbahasa Inggris    | **Hanya** `documents.upload` — pemilik/kontributor/reviewer    | Blok "Draf ringkasan dari model — belum ditinjau", tombol salin; ringkasan resmi hanya berubah lewat revisi yang direview             |

Endpoint: `POST /api/rag/document-insights {documentId}` (pertanyaan untuk semua yang boleh
baca; `summary` dan `currentSummary` `null` bagi yang tidak punya `documents.upload`; dokumen
yang tidak boleh dibaca atau belum terindeks sama-sama `available:false`) dan
`POST /api/rag/suggested-questions {scope}` (cakupan yang sama dengan retrieval; kategori di
luar akses → daftar kosong). Bukti: `tests/http/rag.test.ts` ("generated questions reach
readers, the draft summary only editors, and nothing leaks").

Angka "2/7 summary salah" adalah alasan summary tidak tampil kepada pembaca: tidak ada
permukaan mekanis untuk menolak teks bebas yang keliru. Bagi editor ia berguna sebagai bahan;
bagi pembaca ia akan tampak seperti kalimat dokumen.

### Rerank: server reranker sebagai profil compose opsional

`compose.yaml` menambah service `weknora-reranker` (profil `weknora-rerank`,
`text-embeddings-inference` CPU, model `BAAI/bge-reranker-v2-m3`, ~2,3 GB RAM fp32,
`WEKNORA_RERANK_HF_MODEL=BAAI/bge-reranker-base` untuk VM yang lebih kecil), hanya terjangkau
dari jaringan compose, dan `SSRF_WHITELIST_EXTRA` menambahkan namanya saja.
`pnpm weknora:rerank` memverifikasi lewat `POST /initialization/rerank/check` (field
`modelName`/`baseUrl` camelCase) bahwa WeKnora benar-benar bisa memanggilnya, mendaftarkannya
sebagai model `Rerank`, menulis `WEKNORA_RERANK_MODEL_ID`, dan memin agen. Reranker hanya
mengurutkan ulang chunk yang sudah diambil WeKnora di dalam `knowledge_ids` yang diotorisasi;
ia tidak menghasilkan teks dan sitasi tetap divalidasi IntraDocs.

## 18. Umpan balik jawaban, gap dari asisten, FAQ yang citable, dan chunking

### "Membantu / tidak" per jawaban

Setiap giliran tersimpan (migrasi 029) kini bisa dinilai pemiliknya (migrasi 030,
`POST /api/rag/answer-feedback {turnId, helpful}`). Nilai disimpan di giliran (RLS pemilik;
orang lain → `400`, karena giliran itu tidak terlihat baginya) dan dihitung di audit sebagai
`rag.answer_helpful` / `rag.answer_unhelpful` **tanpa teks** — dashboard menampilkan "dinilai
membantu X/Y" dan tidak pernah pertanyaannya.

### Pertanyaan yang tidak terjawab adalah knowledge gap

Pertanyaan ke asisten yang berakhir abstain, dan jawaban yang dinilai tidak membantu, dicatat
ke `app.search_events` persis seperti pencarian tanpa hasil: hanya bentuk ternormalisasi
(`app.normalise_query` membuang yang tampak identifying), dengan kolom `source`
(`assistant_abstained` / `assistant_unhelpful`). `app.knowledge_gaps` menggabungkannya di bawah
ambang k-anonimitas yang sama (≥3 orang) dan mengembalikan `from_assistant` supaya dashboard
bisa menandai "n via asisten". Menilai "tidak membantu" dua kali tidak menggandakan sinyal.
Bukti: `tests/http/rag.test.ts` ("a vote is the owner's alone…").

### FAQ dengan cara yang aman

FAQ WeKnora (`faq_config`) tetap mati: entri FAQ lahir di WeKnora, tidak punya versi IntraDocs,
dan tidak bisa dikutip atau direview. Bentuk amannya ada di dashboard: pada setiap knowledge
gap, tombol **"Jawab sebagai dokumen"** (bagi yang punya `documents.upload`) membuka
`/unggah?topik=<istilah>` dengan judul terisi. Jawabannya menjadi dokumen IntraDocs biasa —
lewat review, terbit, terindeks, dan bisa dikutip asisten. Model tidak menulis FAQ; orang
menulis dokumen.

### Chunking parent-child: diukur, dipakai

`enable_parent_child` **dibuang oleh handler update** (config tersimpan hanya
`chunk_size`/`chunk_overlap`), jadi seperti `summary_model_id` ia hanya bisa diset saat KB
dibuat: `pnpm weknora:reindex --parent-child` (parent 1200 / child 300 karakter).
`pnpm rag:eval` kini juga melaporkan **sitasi ber-anchor** — kutipan yang ditemukan verbatim di
Markdown versinya sehingga bisa dilompati, bukan hanya ditampilkan.

|                      | flat (400/40) | parent-child |
| -------------------- | ------------- | ------------ |
| recall@5             | 20/20         | 20/20        |
| abstain penuh        | 8/10          | 8/10         |
| kebocoran            | 0             | 0            |
| sitasi ber-anchor    | 60/111 (54%)  | 74/130 (57%) |
| latensi p95 (hangat) | 847 ms        | 520 ms       |

Perbedaannya kecil dan tidak ada yang memburuk; KB produksi di mesin ini memakainya. Tetap
opt-in pada `weknora:reindex` karena buktinya baru dari 7 dokumen.

## 19. S07 tanpa WeKnora: perapian taksonomi, urutan, ekspor, aturan

Bagian mockup S07 yang belum ada tidak butuh AI, hanya belum dikerjakan:

- **Saran perapian taksonomi** (`taxonomySuggestions`, migrasi 031): pasangan label yang
  namanya mirip (trigram `pg_trgm` ≥ 0,45) atau dipakai bersama (Jaccard ≥ 0,75 atas versi
  yang terlihat), keduanya dalam satu kategori; plus label yang tidak dipakai versi aktif mana
  pun. Aksinya memakai API yang sudah ada: gabung (label yang lebih jarang menjadi alias) dan
  hapus. Tidak ada yang berubah sebelum tombol ditekan.
- **"Tidak dipakai" harus benar walau admin tidak bisa membaca dokumennya.**
  `app.is_active_version` menyertakan `can_read_version`, jadi label yang hanya dibawa dokumen
  Rahasia tampak tidak dipakai bagi admin tanpa grant — dan akan dihapus. Hitungannya kini dari
  `app.label_usage_counts()` (SECURITY DEFINER, predikat publikasi saja, hanya angka), digabung
  dengan daftar label yang terlihat lewat RLS. Bukti: `tests/integration/taxonomy-hygiene.test.ts`.
- **Urutan**: seret kategori ke kategori setingkat, atau tombol ↑/↓ (jalur keyboard/pembaca
  layar); keduanya menulis ulang `position` saudara-saudaranya lewat `POST /api/taxonomy/categories`
  dan diaudit. Memindahkan induk tetap lewat form karena server menolak memindahkan kategori
  yang sudah berisi dokumen.
- **Ekspor taksonomi**: tombol ke `GET /api/taxonomy/export` yang sudah ada.
- **Aturan yang berlaku**: panel ringkasan dari pengaturan kategori dan aturan tetap di kode
  (Kritikal → dua tahap, klasifikasi minimum, pengingat review, label AI hanya saran). Bukan
  mesin aturan bebas, dan panelnya mengatakan itu.

## 20. S05 "bantuan metadata" tanpa mengirim draft

Mockup S05 mengusulkan judul, ringkasan, kategori, label, dan deteksi duplikat saat unggah.
Draft saat itu adalah berkas privat yang belum direview, dan §13 sudah menjelaskan mengapa ia
tidak boleh masuk WeKnora walau sementara. Bentuk amannya (`POST /api/uploads/metadata-help`,
panel "Bantuan metadata" di langkah Metadata):

| Bagian mockup           | Cara                                                                                                                                                                   | Yang keluar dari IntraDocs                                                 |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Deteksi duplikat        | Judul + cuplikan awal (≤1.500 karakter, satu baris) dipakai sebagai **pertanyaan** retrieval ke korpus terbit yang boleh dibaca actor; hasil dideduplikasi per dokumen | Cuplikan itu saja — batas kepercayaan yang sama dengan bertanya ke asisten |
| Saran label             | Nama label kategori terpilih yang muncul di teks (lexical, `app.can_upload_to`)                                                                                        | Tidak ada                                                                  |
| Saran kategori          | Kategori yang kosakata labelnya paling banyak muncul                                                                                                                   | Tidak ada                                                                  |
| Judul/ringkasan dari AI | **Tidak dibuat** — butuh ingest draft; draf ringkasan tersedia setelah terbit (§17)                                                                                    | —                                                                          |

Setiap usulan adalah tombol; tidak ada yang diterapkan sendiri, tidak ada yang disimpan.

**Setelah terbit, loop-nya tertutup di form revisi.** Form `/unggah?document=…&base=…`
menampilkan "Saran AI untuk revisi ini": draf ringkasan (§17) dengan tombol **Gunakan sebagai
ringkasan** yang mengisi kolom Ringkasan, dan saran label tersaring (§11) sebagai tombol
**+ label**. Keduanya hanya mengisi form; revisinya tetap direview. Inilah versi "diisikan AI
atau diisi sendiri" yang bisa dibuat aman: AI mengisi _form_, orang mengirim _revisi_.

Viewer tanpa `documents.upload` mendapat `403`; reviewer dengan scope Keamanan saja tidak
melihat label/kategori Infrastruktur; kontributor tanpa grant tidak pernah mendapat dokumen
Rahasia sebagai "mirip" walau cuplikannya mengutip canary-nya. Bukti: `tests/http/rag.test.ts`
("metadata help finds published look-alikes…").

### Catatan operasional dari sesi ini

- **Runner Ollama yatim.** Mematikan `ollama.exe`/`ollama app.exe` tidak mematikan
  `llama-server` anaknya. Setelah tiga restart, empat runner (±2 GB privat masing-masing)
  masih hidup: commit charge 26,7 GB pada mesin 7,9 GB, RAM tersedia 124 MB, `docker` CLI
  menggantung, WeKnora gagal mencapai `host.docker.internal` (proxy backend Docker ikut
  kelaparan), retrieval `503`. Perbaikannya: hentikan `llama-server`, restart Docker Desktop.
  Bila me-restart Ollama, periksa `Get-Process llama-server`.
- **`OLLAMA_KEEP_ALIVE=-1`** (variabel user) menjaga bge-m3 dan model penjawab tetap di GPU;
  tanpa itu reload setelah 5 menit idle memakan ~10 detik per model di mesin tertekan dan
  dua panggilan hybrid-search melewati `WEKNORA_SEARCH_TIMEOUT_MS`.

## 21. S08 tanpa IdP: undangan lokal

Dari tiga hal di mockup S08, satu yang bermakna dan aman tanpa identity provider:
**Undang pengguna** (migrasi 032). Sinkron AD/SSO dan role kustom tetap di luar rilis —
tombol SSO kini mengatakan alasannya, bukan sekadar abu-abu.

Bentuknya jujur terhadap lingkungan lokal: tidak ada email. Administrator memutuskan nama,
alamat, unit, role, dan cakupan kategori **di muka**; sistem membuat **tautan sekali pakai**
(token 32 byte acak, hanya hash-nya yang disimpan, kedaluwarsa 72 jam) yang tampil **satu kali**
kepada administrator untuk disampaikan sendiri. Orang yang diundang hanya melakukan satu hal
di `/undangan/<token>`: menetapkan password (≥12 karakter). Hasilnya akun lokal biasa —
`auth."user"` + `auth.account` seperti seed, profil dan grant lewat `app.accept_invitation()`,
audit `user.invitation_accepted` dengan pengundang sebagai actor dan orang baru sebagai subject.

Otoritasnya meniru `app.assign_user()` dan hidup di SQL: super admin mengundang role apa pun
**kecuali super admin** (itu tetap tindakan basis data yang disengaja); knowledge admin hanya
viewer/contributor/reviewer di unitnya sendiri, tanpa scope global, hanya kategori dalam
scope-nya. Alamat yang sudah punya akun atau undangan terbuka ditolak. Undangan bisa dicabut;
token yang sudah dipakai, dicabut, atau kedaluwarsa tidak bisa dibedakan dari token yang tidak
pernah ada. Bukti: `tests/http/invitations.test.ts` (4).

## 22. Model penjawab 3B, dan dua hal yang baru terlihat karenanya

`qwen2.5:3b-instruct` (1,9 GB) diukur pada laptop GPU 6 GB dengan `pnpm weknora:generation
qwen2.5:3b-instruct` lalu `pnpm weknora:reindex --parent-child` (summary/pertanyaan/tag ikut
model yang dipin):

|                                   | 1.5B                                    | 3B                          |
| --------------------------------- | --------------------------------------- | --------------------------- |
| jawaban hangat                    | 2,4 s                                   | 5,8–7,0 s                   |
| summary layak dipakai (7 dokumen) | 4/7 (2 "No textual content", 1 Inggris) | **7/7**, Indonesia, koheren |
| pertanyaan per chunk              | relevan, 1–2 dangkal                    | relevan, lebih spesifik     |
| auto-tag: cocok / salah / kosong  | 2 / 2 / 3                               | 3 / **14** / 0              |
| saran label lolos penyaring       | 0                                       | 3 — **ketiganya salah**     |
| rag:eval                          | 20/20 · 8/10 · 0                        | 20/20 · 8/10 · 0            |

Kesimpulan: 3B adalah pilihan yang benar untuk **jawaban dan summary** di mesin ber-GPU; untuk
**auto-tag** ia lebih buruk — memberi lebih banyak tag, kebanyakan salah, dan tiga yang lolos
penyaring kosakata (`Kritikal` untuk kebijakan backup, `Monitoring` untuk VPN, `SOP` untuk
lampiran rahasia) lolos hanya karena namanya ada di kategori itu. Saran tetap saran; tidak ada
yang diterapkan. Mesin ini kini memakai 3B; mesin tanpa GPU tetap 1.5B (§10).

### Ringkasan buatan model ternyata ikut terindeks — dan tadinya bisa dikutip

Saat mengukur 3B, abstain turun ke 7/10. Penyebabnya bukan model: WeKnora **mengindeks summary
yang ia buat sebagai chunk** (`chunk_type: summary`) di samping chunk `text` dokumen, dan
hybrid search mengembalikannya sejajar. Di portal ia muncul sebagai kutipan berawalan
"# Summary …" **tanpa anchor** — teks buatan mesin yang tampak seperti kutipan dokumen. Ini
melanggar aturan inti (§13) dan sudah terjadi sejak summary dinyalakan (§17), termasuk pada 1.5B
untuk dokumen yang summary-nya berhasil.

Perbaikan di gerbang: `validateRetrieval` menolak setiap hit yang `chunkType`-nya ada dan bukan
`text` dengan alasan `generated_content` (dihitung sebagai "kandidat ditolak validasi"). Karena
kini satu chunk per dokumen selalu dibuang, retrieval meminta `2 × WEKNORA_MAX_CANDIDATES`
kandidat (plafon 40) dan tetap memotong sitasi pada 6 — tanpa itu recall turun ke 19/20 (a19:
chunk asli dokumen monitoring terdorong keluar oleh empat chunk summary). Hasil setelah
keduanya: 20/20 · 8/10 · 0, dan **sitasi ber-anchor naik 57% → 78%** karena chunk summary
memang tidak pernah bisa dilompati. Bukti: `tests/unit/rag.test.ts` ("a summary WeKnora
generated at ingest is never cited…").

Catatan untuk jalur chat: `knowledge_ids` yang dipin ke model penjawab masih bisa memuat chunk
summary sebagai _konteks_ di dalam WeKnora; yang dijamin adalah ia tidak pernah menjadi
**sitasi** IntraDocs.

### Update knowledge base mengganti seluruh `config`

`PUT /knowledge-bases/:id` dengan hanya `auto_tag_config` (yang dilakukan `weknora:autotag`)
**menghapus** `chunking_config` (menjadi 0/0); reparse berikutnya menghasilkan chunk datar
±500 karakter dan sitasi ber-anchor jatuh ke 40/71. `setAutoTag` kini mengembalikan semua blok
yang diekspos GET. `enable_parent_child` tidak diekspos GET dan dibuang handler update, jadi
tidak bisa dipertahankan lewat API: `weknora:autotag` memeriksa `parent_chunk_id` sebelum
mengubah apa pun dan, bila KB memakai parent-child, mencetak perintah pemulihannya
(`weknora:reindex --parent-child`).

### Index BM25: setiap penghapusan massal merusaknya

Selain penghapusan KB (§7), membersihkan tag + reparse semua dokumen juga meninggalkan
`item_pointer_is_valid(ctid)`. Ekspor ulang satu dokumen tidak pernah memicunya. Kini:
`rebuildBm25Index()` dipanggil di akhir `weknora:reindex` dan `weknora:autotag`,
`pnpm weknora:repair` menjalankannya sendiri, dan `pnpm weknora:status` melakukan satu
hybrid-search sungguhan dan menyebut perintah itu bila gagal.
