# SaaS e-Faktur CoreTax Gateway & Auto-Sync Zoho Books

Gateway SaaS multi-tenant **dua arah** antara Zoho Books dan Coretax DJP:

1. **Zoho Books → Coretax** — webhook invoice Zoho dikonversi menjadi XML Faktur Pajak Keluaran (format impor Coretax) dan dikirim ke email tim finance.
2. **Coretax → Zoho Books** — setelah faktur di-approve di Coretax, Nomor Faktur Pajak (NSFP), tanggal, status, dan PDF faktur dikirim kembali ke invoice yang sama di Zoho Books.

```
 Zoho Books ──webhook──▶ Gateway ──XML via email──▶ Finance ──upload──▶ Coretax
     ▲                     │  ▲                                          │
     │  custom field,      │  │  ekspor Faktur Keluaran (XLSX/CSV),      │
     └── komentar, PDF ◀───┘  └── input manual, atau API ◀───────────────┘
```

---

## 🚀 Fitur

- **Multi-tenant**: API key, konfigurasi pajak, SMTP, dan koneksi Zoho terpisah per klien.
- **Konverter XML Coretax**: kode transaksi 04 (DPP Nilai Lain 11/12, PPN 12%), `RefDesc` = nomor invoice Zoho.
- **Sinkronisasi balik ke Zoho Books** (baru di v1.1.0):
  - Impor file ekspor daftar Faktur Keluaran dari Coretax (**XLSX/CSV**) dengan pratinjau sebelum dikirim.
  - Input manual per invoice, lengkap dengan lampiran **PDF Faktur Pajak**.
  - Endpoint API `POST /api/coretax-result` untuk otomasi (RPA, PJAP, script).
  - Mengisi custom field invoice (nomor, tanggal, status), menambah komentar riwayat, dan melampirkan PDF.
  - Status **"XML Dibuat"** langsung ditulis ke Zoho begitu XML terkirim.
- **Anti-duplikat & anti-loop webhook**: invoice yang isinya tidak berubah, atau sudah bernomor faktur, tidak diproses ulang.
- **Hybrid SMTP**: SMTP pusat atau SMTP kustom per tenant.
- **Superadmin panel**: kelola tenant, suspend, reset password.
- **Enkripsi AES-256-GCM** untuk client secret, refresh token, dan password SMTP di `database.json`.

---

## 🛠️ Prasyarat

- Node.js **v20.12+** (memakai `process.loadEnvFile` dan `fetch` bawaan)
- PM2 dan Nginx (untuk produksi)

---

## ⚙️ Instalasi

```bash
git clone https://github.com/webasta/efaktur-coretax-gateway.git
cd efaktur-coretax-gateway
npm install
cp .env.example .env      # lalu isi SESSION_SECRET, APP_SECRET, SMTP_*
npm test                  # opsional
pm2 start server.js --name efaktur-gateway
```

Login awal: `admin` / `admin` — **segera ganti**.

### Alternatif: Docker Compose

```bash
cp .env.example .env              # isi SESSION_SECRET, APP_SECRET, SMTP_*
mkdir -p data && sudo chown 1000:1000 data   # container berjalan sebagai user node (uid 1000)

# Pindahan dari instalasi PM2 lama: bawa database & kunci enkripsinya
# mv database.json data/ ; [ -f .app-secret ] && mv .app-secret data/

docker compose up -d --build
docker compose logs -f
```

Aplikasi listen di `127.0.0.1:3000`; arahkan Nginx ke sana. Folder `./data` berisi `database.json` dan `.app-secret` — wajib di-backup.
Update setelah `git pull`: `docker compose up -d --build`.

> ⚠️ `APP_SECRET` dipakai untuk mengenkripsi kredensial. Jangan diganti setelah ada data tersimpan.
> Jika dibiarkan kosong, kunci dibuat otomatis di file `.app-secret` — ikutkan file itu dalam backup.

---

## 🔁 Menyiapkan Sinkronisasi Balik ke Zoho Books

### 1. Buat custom field di Zoho Books

Zoho Books → **Settings → Invoices → Field Customization → New Custom Field**:

| Label                | Tipe | API name (default gateway)   |
|----------------------|------|------------------------------|
| Nomor Faktur Pajak   | Text | `cf_nomor_faktur_pajak`      |
| Tanggal Faktur Pajak | Date | `cf_tanggal_faktur_pajak`    |
| Status e-Faktur      | Text | `cf_status_e_faktur`         |

Opsional, untuk menyimpan hasil XML di invoice Zoho:

| Label      | Tipe                               | API name        |
|------------|------------------------------------|-----------------|
| Hasil XML  | **Attachment**, URL / Text, atau Multi-line | `cf_hasil_xml`  |

Isi API name ini di Pengaturan → *Hasil XML*. Jika tipenya **Attachment** (izinkan tipe file XML), file XML diunggah dan dipasang langsung di field itu. Untuk tipe lain, field diisi **link unduhan XML** (`https://.../xml/<token>`, tanpa login, token acak), sehingga muat di tipe field apa pun. Mode *Isi XML lengkap* menulis XML-nya langsung (butuh Multi-line) dan otomatis beralih ke link jika Zoho menolak karena terlalu panjang. File `.xml` juga dilampirkan ke invoice (bisa dimatikan).

API name boleh berbeda; sesuaikan di halaman **Pengaturan** gateway. Gunakan tipe *Text* (bukan dropdown) untuk status karena nilainya mengikuti status dari Coretax (APPROVED, AMENDED, dll.).

### 2. Daftarkan aplikasi OAuth gateway (sekali saja, oleh admin gateway)

Agar tenant cukup klik **🔗 Hubungkan ke Zoho Books** → login → **Accept** tanpa membuka API Console:

1. Buka [api-console.zoho.com](https://api-console.zoho.com) → **Add Client → Server-based Applications**.
2. Isi:
   - **Client Name**: nama yang akan dilihat tenant di layar Accept, mis. `e-Faktur Gateway Asta`
   - **Homepage URL**: `https://efaktur.astakorpora.com`
   - **Authorized Redirect URIs**: `https://efaktur.astakorpora.com/zoho/oauth/callback`
3. Setelah dibuat, buka tab **Settings** pada client tersebut → aktifkan **Multi-DC** (agar akun Zoho di data center .com, .eu, .in, dll. bisa terhubung).
4. Salin **Client ID** dan **Client Secret** ke `.env`:
   ```
   ZOHO_CLIENT_ID=1000.xxxx
   ZOHO_CLIENT_SECRET=xxxx
   ```
5. Terapkan: `docker compose up -d --force-recreate`.

`PUBLIC_BASE_URL` di `.env` harus sama persis dengan domain di Redirect URI (pakai `https://`, tanpa `/` di akhir).

### 3. Hubungkan (tenant)

**Pengaturan → Sinkronisasi Balik ke Zoho Books → 🔗 Hubungkan ke Zoho Books** → login Zoho → **Accept**.
Gateway otomatis menyimpan refresh token, mendeteksi data center, dan memilih organisasi default (bisa diganti dari dropdown jika akun punya beberapa organisasi). Lalu klik **Tes Koneksi Zoho**.

<details>
<summary>Alternatif: Self Client manual (jika aplikasi OAuth gateway belum dikonfigurasi)</summary>

1. [api-console.zoho.com](https://api-console.zoho.com) → **Add Client → Self Client**.
2. Tab **Generate Code**, scope `ZohoBooks.invoices.ALL,ZohoBooks.settings.READ`, durasi 10 menit → salin *code*.
3. Tukar menjadi refresh token:
   ```bash
   curl -X POST "https://accounts.zoho.com/oauth/v2/token" \
     -d "grant_type=authorization_code" -d "client_id=CLIENT_ID" \
     -d "client_secret=CLIENT_SECRET" -d "code=CODE"
   ```
4. Isi di Pengaturan → *Mode lanjutan: Self Client manual* (Organization ID ada di Zoho Books → Settings → Organization Profile).
</details>

---

## 📥 Cara Mengirim Hasil Coretax ke Zoho

### A. Impor file ekspor Coretax (massal)

1. Di Coretax, unduh daftar **Faktur Pajak Keluaran** ke Excel/CSV.
2. Dashboard gateway → **Sinkronkan Hasil Coretax ke Zoho Books** → pilih file → **Pratinjau** → **Kirim ke Zoho Books**.

Kolom yang dibaca (nama header dicocokkan fleksibel, huruf besar/kecil & spasi diabaikan):

| Data           | Header yang dikenali (contoh)                                       | Wajib |
|----------------|----------------------------------------------------------------------|-------|
| Referensi      | `Referensi`, `Reference`, `RefDesc`, `Nomor Invoice`                  | ✅ |
| Nomor faktur   | `Nomor Faktur Pajak`, `No Faktur`, `NSFP`, `Tax Invoice Number`       | ✅ |
| Tanggal        | `Tanggal Faktur Pajak`, `Tanggal Faktur`, `Tax Invoice Date`          |    |
| Status         | `Status Faktur`, `Status`                                             |    |

Kolom **Referensi** berisi nomor invoice Zoho karena gateway mengisinya di `RefDesc` saat membuat XML. Baris yang sudah pernah dikirim dengan data sama akan dilewati, sehingga file yang sama aman diimpor ulang. Invoice yang tidak dibuat lewat gateway tetap dicari langsung di Zoho berdasarkan nomor invoice.

> Jika nomor faktur di Excel tampil sebagai angka (mis. `4.0026E+15`), format kolomnya sebagai **Text** sebelum disimpan — angka 17 digit kehilangan presisi di Excel.

### B. Input manual per invoice

Di tabel riwayat, klik **✏️ Faktur** → isi nomor, tanggal, status, dan (opsional) PDF Faktur Pajak dari Coretax.

### C. API untuk otomasi

```bash
curl -X POST https://efaktur.astakorpora.com/api/coretax-result \
  -H "X-API-Key: asta_live_xxx" -H "Content-Type: application/json" \
  -d '{
    "results": [
      { "invoice_number": "INV-000101", "faktur_number": "04002600000000101",
        "faktur_date": "2026-11-03", "status": "APPROVED",
        "pdf_base64": "<opsional>", "pdf_filename": "FP-INV-000101.pdf" }
    ]
  }'
```

Respons `200` jika semua berhasil, `207` jika sebagian gagal (detail per baris di `results`).

---

## 🔄 Workflow Webhook Zoho (invoice Sent → XML)

Alur yang disarankan:

1. Invoice berstatus **Sent** → Zoho mengirim webhook → gateway membuat XML, mengirim email, dan **melampirkan file XML + link di `cf_hasil_xml`** ke invoice.
2. Finance mengunggah XML ke Coretax. Setelah faktur terbit, nomor faktur + PDF diunggah di dashboard gateway (✏️ Faktur atau impor Excel) → gateway mengisi custom field dan melampirkan PDF di invoice Zoho.

Pengaturan di Zoho Books → **Settings → Automation → Workflow Rules → New Rule**:

- **Module**: Invoices
- **When**: *Created or Edited* (atau *Field update* pada Status)
- **Criteria**: `Status` **is** `Sent`
- **Action**: Webhook → `POST https://efaktur.astakorpora.com/zoho-to-coretax?api_key=API_KEY_ANDA`, body berisi data invoice (`${invoice}` / entity parameter "invoice")

Gateway juga mengabaikan invoice berstatus `draft` atau `void` (balasan 200 dengan `skipped: true`), jadi aman walaupun kriteria workflow terlewat.


Jika Workflow Rule di Zoho dipicu saat invoice **dibuat atau diedit**, update custom field dari gateway akan memicu webhook lagi. Gateway mengabaikan webhook tersebut bila:

- isi invoice yang relevan untuk pajak (tanggal, pelanggan, NPWP, total, line item) tidak berubah sejak XML terakhir, atau
- invoice sudah memiliki Nomor Faktur Pajak.

Jika invoice direvisi (mis. nilai berubah) sebelum di-approve, XML baru akan dibuat dan dikirim. Tambahkan `&force=true` pada URL webhook untuk memaksa pembuatan ulang.

---

## 🧪 Pengujian

```bash
npm test
```

Test memakai mock Zoho Books API dan berjalan tanpa koneksi internet.

---

## 📁 Struktur

```
server.js              Route web, webhook, impor & API
lib/config.js          Konfigurasi dari .env
lib/db.js              Penyimpanan JSON (penulisan atomik)
lib/secret.js          Enkripsi AES-256-GCM
lib/efaktur.js         Konversi invoice Zoho -> XML Coretax
lib/zoho.js            Klien Zoho Books API (OAuth, custom field, komentar, lampiran)
lib/coretaxImport.js   Parser ekspor Coretax (CSV/XLSX)
lib/xlsx.js            Pembaca XLSX tanpa dependensi
lib/sync.js            Logika sinkronisasi Coretax -> Zoho
views/                 Template EJS
test/                  Unit & integration test
```
