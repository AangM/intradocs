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

### 2.2 Tabel pemetaan (`app.rag_index_entries`)

Satu-satunya jembatan antara kedua sistem. Kunci utama `version_id`, sehingga satu versi tidak mungkin punya dua record.

| Kolom                                  | Arti                                                            |
| -------------------------------------- | --------------------------------------------------------------- |
| `version_id` (PK)                      | Versi IntraDocs                                                 |
| `knowledge_id`                         | ID WeKnora; `NULL` selama niat sudah dicatat tetapi belum jadi  |
| `content_sha256`                       | Identitas payload: `PIPELINE_REVISION` + hash berkas + metadata |
| `state`                                | `pending` / `indexed` / `failed` / `revoked`                    |
| `attempts`, `last_error`, `indexed_at` | Budget retry dan jejak kegagalan                                |

`state='revoked'` adalah tombstone: buktinya versi pernah diindeks lalu dicabut.

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
| `langfuse` (5 container)             | Observability memakai health check dan `app.rag_events`                              |
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
| `pnpm weknora:sync` melaporkan `failed > 0`           | Lihat `app.rag_events` action `rag.export_failed` dan kolom `last_error`. Retry dibatasi 5 kali     |
| Sinkronisasi selalu `busy`                            | Ada sync lain berjalan. Lock advisory `(719281,4)` dilepas pada koneksi yang sama                   |
| Jawaban selalu abstain                                | Cek `pnpm weknora:status`. Index kosong, model embedding mati, atau memang tidak ada sumber berizin |
| Sitasi tanpa anchor                                   | Potongan tidak ditemukan di Markdown versi tersebut. Ini benar: locator tidak dikarang              |
| `429`/budget                                          | 5 permintaan AI per menit per akun                                                                  |

Log yang aman dibagikan: `pnpm weknora:status` dan isi `app.rag_events`. Keduanya tidak memuat key, pertanyaan, atau isi dokumen.

## 8. Status gate

| Gate                                                 | Hasil                                                                                       |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Unit (config, ekspor, validasi sitasi, adapter, SSE) | Dijalankan — lihat laporan PR                                                               |
| Integrasi PostgreSQL/RLS                             | Dijalankan pada PostgreSQL lokal sungguhan                                                  |
| Pipeline ekspor + scope retrieval                    | Dijalankan; PostgreSQL nyata, WeKnora memakai **contract stub** `tests/rag/weknora-stub.ts` |
| WeKnora sungguhan end-to-end                         | Lihat laporan PR. Stub bukan bukti perilaku upstream                                        |
| E2E browser                                          | Lihat laporan PR                                                                            |
| Q4 (40 gold questions, recall@5, grounding)          | **BELUM DIKERJAKAN** — butuh corpus dan reviewer domain                                     |

`tests/rag/weknora-stub.ts` adalah test double yang mengikuti swagger resmi. Ia dipakai untuk menguji idempotensi, pemulihan crash dan pencabutan secara deterministik — termasuk kegagalan yang tidak bisa diminta dari server sehat. **Lulusnya suite itu bukan bukti WeKnora asli berperilaku sama.**

Batas yang belum selesai: evaluasi Q4, scheduler sinkronisasi otomatis (saat ini `pnpm weknora:sync` manual), reranker, dan `WEKNORA_MAX_SCOPE_DOCUMENTS` yang membatasi retrieval pada 200 versi teraktif per actor — cukup untuk corpus sintetis, belum untuk 1.000 dokumen pada budget Q5.
