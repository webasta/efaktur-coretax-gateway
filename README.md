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

API name boleh berbeda; sesuaikan di halaman **Pengaturan** gateway. Gunakan tipe *Text* (bukan dropdown) untuk status karena nilainya mengikuti status dari Coretax (APPROVED, AMENDED, dll.).

### 2. Buat kredensial OAuth (Self Client)

1. Buka [api-console.zoho.com](https://api-console.zoho.com) (pakai domain data center Anda, mis. `.com` atau `.eu`) → **Add Client → Self Client**.
2. Tab **Generate Code**, scope:
   ```
   ZohoBooks.invoices.ALL,ZohoBooks.settings.READ
   ```
   durasi 10 menit → **Create** → salin *code*.
3. Tukar code menjadi refresh token (dalam 10 menit):
   ```bash
   curl -X POST "https://accounts.zoho.com/oauth/v2/token" \
     -d "grant_type=authorization_code" \
     -d "client_id=CLIENT_ID" \
     -d "client_secret=CLIENT_SECRET" \
     -d "code=CODE_DARI_LANGKAH_2"
   ```
   Simpan nilai `refresh_token` dari respons.
4. Organization ID ada di Zoho Books → **Settings → Organization Profile**.

### 3. Isi di gateway

**Pengaturan → Sinkronisasi Balik ke Zoho Books**: centang *Aktifkan*, pilih data center, isi Organization ID, Client ID, Client Secret, Refresh Token → **Simpan** → **Tes Koneksi Zoho**. Tes akan memberi tahu jika ada custom field yang belum dibuat.

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

## 🔄 Catatan Workflow Webhook Zoho

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
