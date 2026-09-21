# Menjalankan IntraDocs di luar laptop

Dokumen ini adalah runbook: urutan yang dijalankan, apa yang menahan rilis, dan apa yang
dilakukan saat rilis harus dibatalkan. Yang **belum** ada dan harus diputuskan organisasi
ada di bagian terakhir — dibaca lebih dulu, bukan terakhir.

Sampai rilis ini, satu-satunya profil yang bisa dijalankan adalah `local-dev`, dan
konfigurasi menolak apa pun selain `http://localhost`. Sekarang ada dua profil lagi,
`staging` dan `production`, yang aturannya **lebih ketat**, bukan lebih longgar.

---

## 1. Apa yang berubah pada profil `staging` / `production`

| Aturan               | local-dev                     | staging & production                                                                                                                                                              |
| -------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_URL`            | `http://localhost:*` saja     | wajib **https**, hostname yang dapat dijangkau                                                                                                                                    |
| Cookie sesi          | biasa                         | `Secure` (mengikuti https)                                                                                                                                                        |
| HSTS                 | tidak dikirim                 | `max-age=31536000; includeSubDomains`                                                                                                                                             |
| Origin tepercaya     | localhost + 127.0.0.1 + [::1] | **tepat satu** origin                                                                                                                                                             |
| Database             | hanya host lokal              | host mana pun, tetapi **wajib TLS** (`sslmode=verify-full`) — kecuali loopback, atau jaringan privat satu host yang **dinyatakan tertulis** lewat `DATABASE_PRIVATE_NETWORK=true` |
| Role database        | app/auth/worker terpisah      | sama, tetap ditolak bila memakai owner                                                                                                                                            |
| Secret               | ≥ 32 karakter                 | ≥ **48** karakter, ditolak bila mengandung kata yang dapat ditebak atau terlalu sedikit variasi                                                                                   |
| `STORAGE_ROOT`       | subfolder `var/`              | **path absolut**, tidak boleh di webroot, tidak boleh memuat `..`                                                                                                                 |
| Akun `@example.test` | wajar                         | **menahan rilis** (`ops:preflight`)                                                                                                                                               |

Semua aturan ditegakkan `readRuntimeConfig` (`packages/core/src/config.ts`) dan diuji di
`tests/unit/config-profiles.test.ts`.

**Gagal cepat.** Sebelumnya konfigurasi hanya dibaca di dalam route handler: instalasi
yang salah tetap hidup, port terbuka, dan baru gagal saat ada yang memakainya. Sekarang
`apps/web/src/instrumentation.ts` memvalidasi sekali saat proses start dan keluar dengan
kode **78** (`EX_CONFIG`) bila ditolak. Artinya: container masuk crash-loop, orchestrator
melihatnya, dan **rilis sebelumnya tetap melayani**.

---

## 2. Yang disiapkan sekali per lingkungan

1. **Database.** PostgreSQL 17 dengan ekstensi `vector`. Buat empat role terpisah —
   `intradocs_owner` (migrasi saja), `intradocs_app`, `intradocs_auth`, `intradocs_worker` —
   dengan password berbeda. Aplikasi tidak pernah memakai role owner.
2. **TLS.** Terminasi ada di reverse proxy (nginx/Traefik/LB), bukan di aplikasi.
   `compose.prod.yaml` sengaja **tidak** memegang sertifikat: memindahkannya ke sini akan
   menyembunyikan tempat sertifikat itu diperpanjang. Proxy meneruskan ke `127.0.0.1:3000`.
3. **Volume storage.** Satu volume yang dibagi web dan worker, di luar webroot.
4. **Secret.** `node -e "console.log(crypto.randomBytes(48).toString('base64url'))"`.

```sh
cp .env.production.example .env.production   # isi setiap baris; tidak ada default
docker build -t intradocs:0.3.0 .
docker compose -f compose.prod.yaml --env-file .env.production up -d postgres
DATABASE_ADMIN_URL=... pnpm db:migrate
DATABASE_ADMIN_URL=... pnpm ops:bootstrap-admin --email anda@org.example --name "Nama" --unit "Divisi IT"
```

`ops:bootstrap-admin` membuat **satu** super admin dengan password acak yang ditampilkan
sekali, lalu menolak berjalan lagi selama masih ada super admin aktif — jadi perintah itu
tidak bisa dipakai diam-diam untuk menambah pemilik kedua. Pengguna berikutnya diundang
dari portal. Tidak ada korpus contoh: isi pertama adalah milik organisasi.

### 2a. SSO (OpenID Connect), bila organisasi memilikinya

`AUTH_MODE=oidc` plus `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` (dan `OIDC_LABEL`
untuk teks tombol). Di IdP, daftarkan klien _confidential_ dengan redirect URI
`https://<APP_URL>/api/auth/callback/sso`, alur _authorization code + PKCE_, scope
`openid email profile`. Yang perlu dipahami reviewer:

- **SSO tidak membuat akun.** Subjek IdP ditautkan ke akun yang emailnya sudah diundang
  admin (email harus terverifikasi di IdP); alamat yang belum diundang ditolak di callback
  dengan pesan jelas, dan akun nonaktif tetap ditolak walau IdP menjaminnya. Role dan
  kategori tetap keputusan portal, bukan klaim IdP.
- `id_token` diverifikasi terhadap JWKS discovery (`requireIdTokenVerification`); IdP
  yang discovery-nya tidak memuat JWKS ditolak.
- Password lokal tetap berfungsi berdampingan — itu jalur darurat admin bila IdP mati.
- IdP yang tidak terjangkau membuat tombol SSO menjawab 503 yang bisa diulang, bukan
  merusak sesi yang ada; portal mengecek discovery lagi pada percobaan berikutnya.
- Untuk mencoba alurnya tanpa IdP: `pnpm idp:mock` menjalankan IdP tiruan di
  `http://localhost:3099` (hanya `local-dev` yang menerima issuer http), dan
  `tests/http/sso.test.ts` memverifikasi kelima kasus di atas terhadapnya.

### 2b. Email pemberitahuan, bila organisasi punya relay SMTP

`MAIL_MODE=smtp`, `SMTP_URL` (`smtps://user:pass@relay:465` untuk TLS langsung, atau
`smtp://relay:587` untuk STARTTLS — relay yang tidak bisa upgrade **ditolak**, kredensial
tidak pernah lewat tanpa TLS), dan `MAIL_FROM`. Yang dikirim persis isi lonceng —
penugasan review, keputusan, publikasi, review jatuh tempo, masukan pembaca — sebagai
**satu ringkasan per orang** beberapa menit setelah kejadian terakhir, bukan satu email
per kejadian. Worker yang mengirim; web hanya menampilkan statusnya.

- Setiap orang bisa mematikannya sendiri di Pengaturan; tautan untuk itu ada di setiap
  email. Lonceng tetap berjalan.
- Tautan di email membuka pembaca, yang menerapkan akses penerima saat dibuka — email yang
  diteruskan tidak membuka apa pun untuk orang lain.
- Relay yang gagal: percobaan dihitung, dicoba lagi tiap menit, dan diberhentikan setelah
  lima kali agar alamat yang selalu memantul tidak menyibukkan antrean. Item yang lebih
  dari 7 hari (1 hari bila `MAIL_MODE=off`) diberhentikan tanpa dikirim, sehingga
  menyalakan email belakangan tidak melepas tumpukan lama.
- Di laptop: `MAIL_MODE=file` menulis setiap email sebagai `.eml` ke `var/outbox/`
  (ditolak pada profil deployment).

### 2c. Retensi yang berjalan sendiri

Setiap kategori sudah punya kadens review (`review_days`); pengaju menetapkan tanggal
review dan, bila perlu, kedaluwarsa. Yang kini terjadi tanpa ada yang mengingat, dijalankan
worker tiap jam:

| Keadaan                                                     | Yang terjadi                                                                                                                                                       |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Review ≤ 14 hari lagi                                       | Pengingat ke pemilik (sudah ada).                                                                                                                                  |
| Review jatuh tempo / terlewat                               | Pemilik melihat strip "Masih berlaku" di halaman dokumen: satu klik memajukan tanggal review sebesar kadens kategori **tanpa versi baru**, tercatat di audit.      |
| Review terlewat > `RETENTION_OVERDUE_DAYS`                  | Eskalasi ke admin kategori (lonceng + email), sekali per tanggal review.                                                                                           |
| Kedaluwarsa                                                 | Tidak terbaca dan keluar dari indeks AI (sudah ada).                                                                                                               |
| Kedaluwarsa > `RETENTION_GRACE_DAYS` tanpa draf/revisi baru | **Diarsipkan otomatis**: dicabut seperti pencabutan manual, alasan tersimpan di versi, audit `document.archived_by_policy` atas nama pemilik, pemilik diberi tahu. |

Yang tidak dilakukan: menghapus berkas. Arsip tetap ada untuk pemilik dan auditor; penghapusan
fisik adalah kebijakan penyimpanan organisasi (§6). Dashboard admin menampilkan keempat
keadaan di atas dalam cakupan admin tersebut.

---

## 3. Setiap rilis

```sh
pnpm ops:backup                                   # sebelum apa pun
pnpm ops:verify-backup var/backups/<stamp>        # restore drill; menandai manifest
pnpm ops:preflight                                # gate — exit 1 menahan rilis
docker build -t intradocs:<versi> .
DATABASE_ADMIN_URL=... pnpm db:migrate
INTRADOCS_IMAGE=intradocs:<versi> docker compose -f compose.prod.yaml --env-file .env.production up -d
pnpm ops:ready                                    # dependensi + pemilik yang dihubungi
```

`ops:preflight` menahan rilis bila: konfigurasi ditolak, origin bukan https, secret terlalu
lemah, storage di webroot, ada migrasi yang belum diterapkan, masih ada akun `@example.test`,
tidak ada super admin aktif, atau **backup terbaru belum pernah di-restore**. Yang terakhir
disengaja: backup yang belum pernah dipulihkan belum terbukti backup. `ops:verify-backup`
menuliskan `verifiedAt` ke `manifest.json`, dan itulah bukti yang dibaca preflight.

---

## 4. Saat terjadi sesuatu

**Alarm.** `pnpm ops:watch` memeriksa `/api/health` berkala dan hanya mencetak saat
**berubah** (UP/DOWN), lalu keluar dengan kode 1 setelah gagal `--grace` kali berturut-turut.
Itu yang dibaca supervisor, cron, atau skrip pager:

```sh
pnpm ops:watch --interval 30 --grace 3
```

**Rollback.** Migrasi bersifat maju-saja, jadi pertanyaannya bukan "bagaimana rollback"
melainkan "apakah rollback kode saja cukup":

```sh
pnpm ops:rollback-check v0.2.0
```

- _AMAN_ → skema tidak berubah sejak ref itu; jalankan ulang compose dengan
  `INTRADOCS_IMAGE` versi lama. Selesai.
- _HATI-HATI_ → database lebih maju daripada kode lama. Pilihan pertama hampir selalu
  **tetap di rilis sekarang dan perbaiki maju**. Bila benar-benar harus mundur, kode lama
  **dan** `pnpm ops:restore var/backups/<stamp sebelum migrasi> --yes` — dan semua
  perubahan setelah backup itu hilang. Perintah rollback-check mencetak persis ini.

**Indeks AI.** WeKnora tidak ikut di-backup: isinya turunan dari `app.rag_index_entries`
dan Markdown kanonik. Setelah restore, `pnpm weknora:sync` membangunnya kembali.

---

## 5. Kapasitas yang terukur (Q5)

`pnpm ops:loadtest --users N --seconds S --budget MS` masuk sebagai pembaca nyata (sesi
asli, RLS aktif, database sungguhan) dan meminta halaman yang benar-benar dibuka orang:
beranda, katalog, pencarian, dokumen. Keluar dengan kode 1 bila p95 mana pun melewati
anggaran atau ada permintaan gagal.

Diukur **20 September 2026** pada mesin rujukan (laptop 7,7 GB yang _sekaligus_ menjalankan
WeKnora, reranker, ClamAV, Postgres, dan Ollama — jadi ini lantai, bukan langit-langit):

| Pembaca serentak | p50         | p95              | Throughput | Gagal |
| ---------------- | ----------- | ---------------- | ---------- | ----- |
| 1                | 195–570 ms  | 282–640 ms       | 3,1 req/s  | 0     |
| 4                | 304–504 ms  | 461–**774** ms   | 9,7 req/s  | 0     |
| 10               | 804–1630 ms | 1039–**2232** ms | 9,8 req/s  | 0     |

Bacaannya: server jenuh di **≈10 req/s** pada mesin ini — throughput 4 dan 10 pembaca sama,
yang bertambah hanya antrean. Anggaran p95 800 ms terpenuhi sampai **≈4 pembaca serentak**;
tidak ada satu pun permintaan gagal bahkan saat jenuh. Angka ini **bukan** kapasitas
deployment: host khusus tanpa model bahasa di sampingnya akan jauh lebih tinggi. Jalankan
ulang perintah yang sama di host target sebelum pilot — itulah gunanya ia ada.

Asisten AI sengaja di luar cakupan load test: satu jawaban menduduki model 3B selama
beberapa detik, jadi yang terukur adalah Ollama, bukan portal. Kapasitasnya pertanyaan
terpisah (satu generasi pada satu waktu di mesin rujukan).

---

## 6. Yang masih menjadi keputusan organisasi

Tidak satu pun bisa diselesaikan dari repositori ini, dan tidak satu pun disembunyikan:

| Hal                            | Kenapa bukan pekerjaan kode                                                                                                                                                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Pendaftaran klien OIDC**     | Kodenya ada (§2a): `AUTH_MODE=oidc` menambahkan tombol SSO yang mengautentikasi akun yang sudah diundang. Yang harus diberikan organisasi: issuer, client id/secret, dan persetujuan security. Sinkronisasi direktori (SCIM) **tidak** ada. |
| **Sertifikat TLS & DNS**       | Dimiliki tim infrastruktur; aplikasi mensyaratkan https tetapi tidak memegang sertifikat.                                                                                                                                                   |
| **Kebijakan data**             | Klasifikasi, kadens review per kategori, dua jendela retensi (§2c), dan siapa yang boleh menyetujui apa adalah keputusan pemilik dokumen; default 30 hari hanya titik awal. Penghapusan fisik arsip tidak diotomatiskan.                    |
| **Review security & ops**      | Tinjauan pihak ketiga atas RLS, header, dan runbook ini.                                                                                                                                                                                    |
| **UAT pemilik domain**         | Q4: mutu jawaban AI pada korpus **nyata**, bukan sintetis.                                                                                                                                                                                  |
| **OCR (PDF pindai, DOC lama)** | Butuh layanan `docreader` WeKnora ±4 GB; jalurnya sama dengan PPTX (WEKNORA.md §27), yang kurang hanya memori di host. Sampai itu ada, unggahan PDF pindai ditolak dengan pesan jelas — bukan diterima diam-diam lalu kosong.               |
| **Backup off-site**            | `ops:backup` menulis ke disk lokal. Menyalinnya ke luar mesin adalah kebijakan penyimpanan organisasi.                                                                                                                                      |

Pilot boleh dimulai tanpa SSO dan tanpa OCR; keduanya tercatat sebagai batasan yang
diketahui, bukan kejutan.
