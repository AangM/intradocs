# Implementasi — satu gate, satu bukti

## 0. Status terkini (24 September 2026)

**MVP lokal M0–M4 selesai; M5 (V1) hampir lengkap; modul Technology Architecture ada. Semua
pada data sintetis. Pilot/go-live Telkom BLOCKED** oleh hal yang memang butuh organisasi
(IdP SSO nyata, kebijakan data, review security/ops, UAT pemilik domain).

Bukti yang dijalankan pada commit terakhir di laptop pengembang (Windows 11, Docker WSL 3,8 GB),
selain CI GitHub (format, lint, typecheck, unit, build, verifikasi source) pada setiap PR:

| Gate                                        | Hasil                                                         |
| ------------------------------------------- | ------------------------------------------------------------- |
| `pnpm check` (lint, types, unit, build)     | PASS — 377 unit                                               |
| `pnpm test:integration` (RLS nyata)         | PASS — 72                                                     |
| `pnpm test:http` (app + ClamAV + converter) | PASS — 126, 1 skip (demo-login bila `DEMO_LOGIN` off)         |
| `pnpm test:e2e` axe desktop + mobile        | PASS — 8/8                                                    |
| `pnpm rag:eval` (40 pertanyaan berlabel)    | recall@5 100%, 0 kebocoran lintas izin — lihat WEKNORA.md §22 |
| Security review, UAT, deploy nyata          | NOT RUN — butuh persetujuan organisasi                        |

Rincian per milestone/quality gate ada di §4, per layar PRD di §5; keputusan organisasi yang
tersisa di [DEPLOY.md §6](DEPLOY.md). Riwayat checkpoint sebelumnya ada di git log, bukan di sini.

## 1. Urutan pelaksanaan

| Tahap                       | Deliverable / demo yang dapat direview                                                                                                                                                                                | Syarat selesai dan ketergantungan                                                                                                                                                                                                 |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0 · Boot lokal             | Repository/toolchain, Docker core, .env.example tanpa secret, migrasi auth/DB awal, seed sintetis, login lokal nyata, root dev scripts; adapter boundaries dan health check.                                          | Clone bersih dapat disiapkan dan berjalan lokal tanpa SSO/GPU/API key. App dapat start/stop ulang dengan data persisten. Patch dipin; keputusan produksi tidak memblokir langkah ini.                                             |
| M1 · Fondasi aman + visual  | Schema/migrasi, session, DAL/RLS, role/scope; shell portal/admin/reader/chat mengikuti token. Demo dua identitas dengan hak berbeda, termasuk akses URL langsung yang ditolak.                                        | Q1 dan subset Q2; routes/shell disetujui secara visual. Fixture UI tidak menjadi data produksi. S08 dan layout S01–S10 mulai tercakup.                                                                                            |
| M2 · Dokumen end-to-end     | Aktifkan profil knowledge; spike converter/locator pada laptop sebelum memperluas format. Upload→scan→konversi→MD+provenance→preview→draft; kategori/label; duplicate dan error/retry. MD/TXT/PDF bertesks/DOCX/XLSX. | Q3 konversi lulus pada fixtures; original/MD persisten; CPU/RAM diukur. Scanner unavailable membuat upload menunggu/ditolak, bukan bypass. S03–S05/S07.                                                                           |
| M3 · Publikasi & discovery  | Approval satu/dua tahap, revisi/tolak, outbox, versi, publikasi atomik, lexical search, katalog/filter, review/expiry, audit, feedback, favorit, histori, notifikasi dan KPI dasar.                                   | Q2/Q3 lulus termasuk crash/retry/duplikasi/race. Demo dua approver lalu pembaca berizin; belum disetujui tidak terlihat. S01–S08 dan dasar S10.                                                                                   |
| M4 · RAG lokal + gate pilot | RAG lokal WeKnora + Ollama (tanpa provider cloud), retrieval/chat bersumber, scope/follow-up, budget, histori aman dan evaluasi. Siapkan integrasi OIDC terhadap IdP yang benar-benar tersedia.                       | MVP lokal diuji end-to-end dengan fixtures. **Pilot Telkom nyata tetap terblokir** sampai SSO/offboarding, provider/data, Q1–Q6 dan persetujuan security/ops/domain lulus; status OIDC tidak boleh disebut lulus hanya dari stub. |
| M5 · Kelengkapan V1         | Fitur V1 pada tabel S01–S10: format tambahan, metadata/precheck AI, semantic duplicate, diff/rollback, role kustom, taxonomic cleanup, knowledge gaps, export/share aman.                                             | Pecah per vertical PR, format satu per satu; setiap capability punya negative tests. Tidak mengklaim “mockup lengkap” sebelum seluruh item V1 yang disetujui lulus.                                                               |
| Lanjut · Ekspansi           | Ticketing/chat, API integrasi, PWA sesuai kebijakan, dashboard eksekutif dan unit lain.                                                                                                                               | Perlu kebutuhan dan owner nyata; bukan otomatis bagian MVP/V1. Rujuk S11.                                                                                                                                                         |

Jangan menunda approval, audit, klasifikasi, dan keamanan ke sesudah pilot walaupun diagram waktu mentor memisahkan fondasi dan tata kelola. M0–M4 berurutan; pekerjaan UI mandiri boleh paralel sesudah kontrak data/scope disepakati. Integrasi yang belum tersedia tidak diganti stub lalu disebut selesai.

**Tim dan ritme:** dua orang, tanpa deadline. Developer A fokus web/UI, auth/session dan UX review; Developer B fokus data, ingestion, workflow, search/RAG dan operasi lokal. Schema/policy/API disepakati bersama sebelum pekerjaan paralel. Tiap PR direview orang lainnya; auth, perubahan izin dan publikasi tidak boleh self-merge tanpa review. Maksimal satu pekerjaan aktif per orang, satu milestone produk aktif. Dua developer tidak sama dengan dua approver organisasi; akun dummy hanya untuk menguji alur, bukan menggantikan review manusia saat pilot.

Tidak ada janji 5–6 bulan atau estimasi hari yang dibuat-buat. Demo per irisan fitur: login/RBAC → MD upload → approval → search → chat. Tidak ada sprint khusus “menulis rencana lagi” sebelum mulai M0.

### Kontrak setup lokal yang harus dibuat pada M0

Node.js 24 LTS, pnpm dan Docker Compose; Python dalam container. Sediakan script lintas OS: `pnpm setup:local` (preflight, env lokal, services core, migration/seed idempotent) lalu `pnpm dev` (web+worker). Tambahkan start/stop profile knowledge dan health diagnostics; model cache volume bertahan antar restart. `setup:local`, `dev`, `start`, `services:stop`, dan `doctor` sekarang sudah ditulis; pembuktian boot/restart dari mesin bersih masih wajib. Runtime Python dan profil knowledge belum dibuat pada M1.

Akun demo memakai credential acak, diabaikan Git; tanpa SMTP dan tanpa open registration. Tidak mengikat port ke semua interface secara default. Installer tidak menghapus volume/data tanpa konfirmasi. Model downloads membutuhkan internet awal, tetapi tidak mengunggah dokumen. Ukur RAM/disk platform target sebelum mengaktifkan Docling/OCR; core harus tetap dapat dikembangkan ketika layanan berat dimatikan.

## 2. Quality gates yang menjadi definition of done

### Q1 — kode dan kontrak

CI wajib lint, TypeScript strict, unit/integration tests, production build, Python lint/tests, pemeriksaan migration, dependency/secret scan. Migrasi diuji dari DB kosong dan versi sebelumnya; tidak melakukan destructive migrate tanpa backup/approval. Policy, state machine, locator dan data validation mempunyai tes eksplisit, bukan mengejar persentase coverage kosmetik.

Command aktif saat ini tercantum di README utama. `pnpm check`, unit/content/DB/HTTP/E2E test source, source verification, dan CI sudah ditulis. CI GitHub berjalan pada setiap PR (format, `pnpm check`, verifikasi source); suite DB/HTTP/E2E/RAG/Python butuh layanan lokal dan dijalankan di laptop. Diff piksel otomatis belum ada.

### Q2 — akses dan keamanan

Uji profil `local-dev`/`staging`/`production`: akun demo/seed/`DEMO_LOGIN` tidak dapat aktif di `production`; key tidak masuk bundle browser; tidak ada provider cloud atau fallback saat error. Uji local credentials, session expiry/revoke dan guard konfigurasi tanpa menunggu IdP. Sebelum pilot nyata tambahkan OIDC callback/issuer/nonce/PKCE, account-linking dan offboarding sesungguhnya.

Gunakan PostgreSQL+pgvector dan RLS nyata, bukan SQLite atau mock permission saja. Buat dua unit, kategori parent/child, lima role, dokumen seluruh klasifikasi, draft dan versi lama; test matrix allow/deny serta reuse connection pool.

Kasus wajib: IDOR URL dokumen/file, manipulasi body role/user/scope, grant escalation, reviewer beda kategori, self-approval, actor sama pada dua tahap, kategori dipindah, pencabutan saat search/generation/history/export, deactivated user, session stale, thumbnail/citation/download, counts/autocomplete/duplicate warning, dan cache lintas user. Uji injection lewat MD/HTML/link, prompt injection di dokumen, forged citation IDs, archive bomb/path traversal/XXE dan file MIME palsu. Tidak ada request yang tidak sah boleh menerima isi atau metadata terlindungi pada suite tersebut.

Security reviewer manusia tetap diperlukan; “0 bocor pada suite” tidak berarti membuktikan tidak ada kerentanan pada semua input.

### Q3 — data dan workflow

Minimal satu fixture representatif tiap format pilot, ditambah multi-kolom PDF, tabel SLA XLSX, kode, Unicode Indonesia, dokumen kosong/rusak/encrypted/oversize, lampiran dan secret palsu. Verifikasi angka/unit/urutan langkah, MD dan source mapping; reviewer bisa membuka lokasi sitasi yang benar. File tak dapat dikonversi menghasilkan error yang dapat ditindaklanjuti, bukan teks kosong yang diberi label sukses.

Submit membekukan versi; perubahan membatalkan approval; approver paralel menghasilkan satu keputusan valid. Matikan worker saat proses, hidupkan ulang: tidak ada versi ganda/publikasi dini. Retry indeks gagal tidak menghilangkan versi aktif; revoke/expiry menghentikan retrieval meskipun stale chunk masih tersimpan. Scan gagal membuat file menunggu/quarantine. Uji original+MD+lampiran dan recovery artefak orphan.

### Q4 — kualitas AI, bukan angka pemasaran

Siapkan awal **40 pertanyaan berlabel** dari dokumen yang boleh diuji: 20 answerable termasuk multi-sumber, 10 tanpa bukti/konflik, 10 percobaan lintas izin; variasikan istilah Indonesia, Inggris, kode teknologi dan follow-up. Prompt-injection adversarial cases tetap ditambah melalui Q2. Pisahkan tuning questions dari holdout dan simpan expected source/locator/version serta alasan abstain.

Target penerimaan usulan:

- Retrieval recall@5 ≥90% pada set answerable, dihitung terhadap sumber gold yang ditentukan reviewer.
- Semua citation ID/lokasi valid dan bisa diakses; ≥95% klaim faktual didukung sumber pada review manusia. Tidak boleh ada klaim kebijakan kritikal yang tak didukung.
- Semua kasus ACL pada suite ditolak tanpa kebocoran. Kasus tanpa bukti/konflik tidak boleh diberi jawaban pasti yang mengarang.
- Model, tokenizer, prompt, chunking, latensi dan token penggunaan tercatat. Ulangi holdout ketika salah satunya berubah. Kegagalan tidak diperbaiki dengan memalsukan angka atau melonggarkan izin.

### Q5 — UI, aksesibilitas, dan performa

Ikuti prosedur visual [UI.md](UI.md): S01–S10, desktop setara, 1024/390 px, scroll bawah dan state penting. Semua delta harus direview. Keyboard-only dan axe: tidak ada blocker serius/kritikal; kontras AA, focus, status upload/chat yang terbaca screen reader. Semua tombol cakupan rilis bekerja, tanpa overflow/clipping/overlap.

Budget awal untuk diuji, **bukan hasil benchmark**: 1.000 dokumen/sekitar 50.000 chunk, 30 sesi portal aktif dan 5 permintaan AI bersamaan; catat hardware/network/cold-warm runs. p95 API metadata ≤500 ms; search end-to-end ≤1 detik pada kondisi normal; jawaban AI selesai p95 ≤15 detik pada model target; LCP reader/help center ≤2,5 detik pada profil perangkat/jaringan yang ditetapkan M0. Target JS awal route baca ≤200 KiB gzip; lazy-load editor/chart.

Angka beban di atas adalah gate pilot pada hardware yang dicatat, bukan tuntutan semua laptop melewatinya saat M0. Pengembangan mulai dari fixtures kecil; smoke test lokal dan load test pilot dicatat terpisah. Beban, latency, dan ukuran bundle tidak boleh dipenuhi dengan menghapus auth/audit atau mengurangi corpus tanpa pelaporan. Bila model tidak mencapai target, ubah kapasitas/model/budget lewat keputusan terukur; jangan menjanjikan semua berjalan ringan di CPU.

### Q6 — operasi dan penerimaan nyata

Uji deploy, health/readiness, rollback release, restore DB+objects, expired/revoked data setelah restore, crash worker, scanner/model/IdP down, dan alarm dengan owner. CI/artifact/model aman dari secret dan berkas internal; egress provider mengikuti kebijakan. Catat backup, retensi, data residency, quota AI dan prosedur insiden; keputusan organisasi di DEPLOY.md §6 tidak boleh kosong sebelum go-live.

UAT: contributor unggah dokumen; dua reviewer menuntaskan approval; viewer yang berizin menemukan jawaban dan membuka bukti; viewer beda scope tidak bisa; owner memperbarui/mencabut dokumen; hasil search/chat mengikuti perubahan. Persetujuan mentor mencakup visual, pemilik domain mencakup isi, tim security/ops mencakup keamanan/deployment. Jangan mengklaim “ISO 27001 compliant” dari implementasi fitur saja.

## 3. Cara review per PR agar hemat

Satu PR = satu vertical slice yang dapat didemokan, bukan seluruh platform. Implementasikan hanya gate aktif. Sertakan:

- Requirement IDs (Sxx), delta UI bila ada, dan maksimal tiga poin perubahan.
- Command tes + hasil PASS/FAIL/NOT RUN, commit/log artifact; screenshot untuk perubahan UI.
- Apa yang belum diverifikasi, perubahan dependency/schema dan risiko migrasi.
- Satu instruksi review dan satu langkah berikutnya.

Demo visual memakai fixture deterministik; functional test memakai identitas dan data uji yang konsisten dengan RBAC. Jangan mengirim dokumen internal ke chat coding hanya agar test bisa dibuat—utamakan sampel yang sudah disanitasi/disetujui.

## 4. Status per milestone dan quality gate

| Item                  | Status sekarang                                                                                                                                                                                                                                                                                                     | Bukti                                                                                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Pembacaan mockup 1–11 | DONE                                                                                                                                                                                                                                                                                                                | Peta PRD/UI, hash referensi asli                                                                                                                                                     |
| M0–M3                 | DONE (lokal, sintetis)                                                                                                                                                                                                                                                                                              | README "Hasil implementasi"; unit 266 / integrasi RLS 52 / HTTP 47 / e2e 14 (WEKNORA.md §8)                                                                                          |
| M4 · RAG lokal        | DONE (lokal); gate pilot BLOCKED                                                                                                                                                                                                                                                                                    | `rag:eval --chat` 20/20 · 8/10 · 0 bocor (WEKNORA.md §8, §25); SSO/OIDC belum ada                                                                                                    |
| M5 · V1               | SEBAGIAN — lihat §5 di bawah                                                                                                                                                                                                                                                                                        | Yang ada: saran label, akses, bacaan wajib, cabut massal, diff+rollback, merge label, gap, undangan, PPTX/HTML, role kustom. Yang tidak: OCR (butuh docreader ~4 GB), email/@mention |
| Q1 kode               | LULUS lokal; CI GitHub hijau pada setiap PR                                                                                                                                                                                                                                                                         | `pnpm check`, `.github/workflows/ci.yml`                                                                                                                                             |
| Q2 akses              | LULUS pada suite lokal; OIDC ADA dan diuji dengan IdP tiruan (`pnpm idp:mock`); IdP organisasi dan offboarding BELUM                                                                                                                                                                                                | integrasi RLS 52, HTTP 47, e2e canary; §5 WEKNORA.md                                                                                                                                 |
| Q3 data/workflow      | LULUS pada fixture; PPTX/HTML ADA; OCR PDF pindai ADA (Tesseract lokal, tes Python+HTTP); DOC lama/ZIP BELUM                                                                                                                                                                                                        | tests/integration, tests/http/uploads                                                                                                                                                |
| Q4 kualitas AI        | LULUS pada corpus sintetis; review grounding pemilik domain BELUM                                                                                                                                                                                                                                                   | 40 gold questions, `pnpm rag:eval`                                                                                                                                                   |
| Q5 UI/aksesibilitas   | Visual DONE (UI.md §5, U09–U15); **axe + keyboard-only LULUS**; **load test ADA** (`pnpm ops:loadtest`) — pada mesin rujukan p95 memenuhi anggaran 800 ms sampai ≈4 pembaca serentak, jenuh ≈10 req/s, 0 gagal; ulangi di host target                                                                               | `pnpm ui:shots`, `pnpm exec playwright test tests/e2e/a11y.spec.ts`, `pnpm ops:loadtest` (angka di docs/DEPLOY.md §5)                                                                |
| Q6 operasi            | **LULUS untuk yang dapat diotomatiskan** — `ops:backup`, `ops:verify-backup` (drill menandai manifest), `ops:restore`, `ops:ready`, **`ops:preflight`** (gate rilis), **`ops:watch`** (alarm, exit 1), **`ops:rollback-check`**; TLS, kebijakan data, dan backup off-site tetap keputusan organisasi (DEPLOY.md §6) | `pnpm ops:preflight`, `pnpm ops:watch`, `pnpm ops:rollback-check <ref>`; runbook: docs/DEPLOY.md                                                                                     |
| Go-live Telkom        | BLOCKED                                                                                                                                                                                                                                                                                                             | SSO nyata, kebijakan data, persetujuan security/ops/mentor                                                                                                                           |

## 5. Review kebutuhan PRD §2 — apa yang nyata, apa yang belum (13 September 2026)

Legenda: ✅ ada dan diuji · ◐ ada sebagian / dengan batas · ✗ belum ada · — bukan target rilis ini.

| Layar | Pilot/MVP (PRD §2 kolom kiri)                                                                                                                                                                                                                                                                                                     | V1 (kolom kanan)                                                                                                                                                                                                                      |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S01   | ✅ hero → Tanya AI, kategori, paling dibaca, publikasi terbaru, hitungan sesuai akses, topik kurasi                                                                                                                                                                                                                               | ✅ topik populer dari log 30 hari (k-anonim ≥3)                                                                                                                                                                                       |
| S02   | ✅ kata kunci + semantik (kartu sumber AI), facet kategori/label/format/waktu/status/pemilik, sort, paginasi, draft sendiri; jawaban tersusun lewat tombol ke asisten                                                                                                                                                             | ✅ permintaan akses via `/akses`; judul terkunci tidak bocor (tes). BM25: tidak dibangun, belum terbukti perlu                                                                                                                        |
| S03   | ✅ tabel, versi/pemilik/metadata/klasifikasi/status, filter, paginasi, draft & antrean sendiri, favorit, riwayat baca                                                                                                                                                                                                             | ✅ cabut massal atomik dengan konfirmasi + audit                                                                                                                                                                                      |
| S04   | ✅ reader tiga kolom, TOC, kode/tabel, versi immutable, metadata approval, lampiran/original berizin, dokumen terkait, feedback                                                                                                                                                                                                   | ✅ diff versi (`/versi`) dan rollback via draft                                                                                                                                                                                       |
| S05   | ✅ empat langkah, multi-file, 50 MiB, konversi→preview→metadata→submit, MD/TXT/PDF berteks/DOCX/XLSX, duplicate warning                                                                                                                                                                                                           | ◐ bantuan metadata ✅; **PPTX ✅** via parser WeKnora (§27, hanya bila WeKnora aktif); **HTML ✅** via converter lokal (teks + struktur blok, skrip/gaya/tautan dibuang); **OCR/DOC lama/ZIP ✗** — tidak ditampilkan sebagai didukung |
| S06   | ✅ antrean/detail, preview asli & konversi, catatan, approve/revisi/tolak, 1–2 tahap, larangan self-approval, ClamAV + pola secret, audit, publikasi lalu indeks                                                                                                                                                                  | ◐ bacaan wajib ✅, pra-cek otomatis ✅; **@mention ✗, email/kanal ✗** (butuh integrasi yang disetujui), bantuan AI duplikasi hanya di unggah                                                                                          |
| S07   | ✅ CRUD ≤3 tingkat, leaf, label multi, urutan, cegah siklus/hapus terpakai, aturan akses/Kritikal/review                                                                                                                                                                                                                          | ✅ drag-and-drop + ↑/↓, ekspor, merge label, saran mirip/tidak terpakai                                                                                                                                                               |
| S08   | ✅ lima role, matriks, scope, aktivasi/nonaktivasi, audit, login lokal nyata; reviewer tidak lintas cakupan. **SSO OIDC ◐** — ada dan diuji dengan IdP tiruan; IdP organisasi belum (blokir pilot)                                                                                                                                | ✅ undangan lokal sekali pakai; **editor role kustom ✅** — role bernama di atas satu role bawaan yang hanya _mempersempit_ kemampuan (migrasi 039–040, `docs/UI.md` U15); dipakai di penugasan dan undangan, dicatat di audit        |
| S09   | ✅ percakapan pribadi multi-turn (§24), scope KB/kategori/dokumen, sumber versi+lokasi, tidak ditemukan, status proses (jawaban tampil saat ditulis) + **Hentikan**, feedback, histori dgn recheck izin. **Konflik antar-sumber ◐** — dideteksi untuk angka+satuan yang berbeda antar dokumen (§27), bukan pertentangan kata-kata | ✅ ekspor Markdown, saran lanjutan (§25), tautan sumber berautentikasi; "lampirkan" = scope dokumen yang dibuka ◐                                                                                                                     |
| S10   | ✅ KPI per status, aktivitas baca/chat, durasi approval, pencarian tanpa hasil, kontributor, filter periode/unit, empty state                                                                                                                                                                                                     | ◐ knowledge gap teragregasi ✅ + "Jawab sebagai dokumen"; **laporan ekspor CSV ✅** (`/api/reports/dashboard`, tanpa istilah gap dan tanpa data per orang); penugasan penulis formal ✗                                                |
| TA    | ✅ Technology Architecture (layer teknologi EA): impor Sparx XMI/CSV lewat alur review (ClamAV, original immutable, diff per field, empat mata, audit), katalog, halaman elemen dengan dampak/dependensi/riwayat, pencarian global, tanya arsitektur deterministik + pencarian semantik KB WeKnora kedua; axe desktop+mobile      | Impor langsung dari repositori Sparx (Pro Cloud/OSLC) ✗; layer Business/Data/Application ✗                                                                                                                                            |
| S11   | — dokumen (ARCHITECTURE/PLAN/WEKNORA), bukan layar                                                                                                                                                                                                                                                                                | —                                                                                                                                                                                                                                     |

**Kontrak alur PRD §3:** 1 kontribusi ✅ · 2 validasi ✅ · 3 publikasi ✅ (staging indeks, gagal
indeks tidak dilaporkan sukses) · 4 konsumsi ✅/◐ — sitasi membuka bagian sumber ✅, abstain ✅,
"sumber bertentangan → tampilkan konflik" ◐ (angka+satuan, WEKNORA.md §27) · 5 pemeliharaan ✅
(pengingat, expiry, feedback ke pemilik, revisi lewat review).

**Aturan §4 yang tidak bisa ditawar:** semuanya punya tes negatif — kebocoran lewat judul/
cuplikan/hitungan/related/duplicate/AI/chat lama (integrasi RLS + HTTP + e2e canary), draft
tidak masuk retrieval, MD tidak ditulis ulang AI (sitasi harus verbatim di Markdown), lampiran
mengikuti klasifikasi induk, ekspor jawaban tetap draft. Satu yang belum diuji sebagai suite:
**autocomplete** — tidak ada fitur autocomplete, jadi tidak ada permukaan bocornya.

**Kesimpulan jujur:** MVP lokal (definisi PRD §1) terpenuhi end-to-end pada data sintetis,
termasuk hampir semua kolom V1 yang tidak memerlukan integrasi eksternal. Yang tersisa adalah
(a) hal yang memang butuh organisasi — SSO/OIDC, email/kanal, kebijakan data, security/ops
review, UAT pemilik domain, sertifikat TLS, backup off-site; (b) format V1 yang belum —
DOC lama dan ZIP (PPTX, HTML, dan PDF pindai lewat OCR sudah); (c) tidak ada lagi: editor role kustom
selesai (U15), load test selesai (`ops:loadtest`, angka di DEPLOY.md §5), rollback dan alarm
selesai (`ops:rollback-check`, `ops:watch`). Daftar keputusan organisasi yang tersisa ada di
**docs/DEPLOY.md §6**. Tidak satu pun dari itu boleh disebut selesai lewat stub.
