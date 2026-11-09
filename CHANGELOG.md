# Changelog

Semua perubahan penting pada project **SaaS e-Faktur CoreTax Gateway** akan dicatat di file ini.

Format changelog ini mengacu pada [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) dan project ini menerapkan [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.2.0] - 2026-11-09

### 🚀 Added
- Tombol **"Hubungkan ke Zoho Books"** (OAuth authorization code): tenant cukup login dan Accept, tanpa API Console. Data center, refresh token, dan organisasi terdeteksi otomatis; pilihan organisasi bila lebih dari satu.
- Tombol **Putuskan** yang juga mencabut refresh token di Zoho.
- Docker: port host bisa diatur lewat `HOST_BIND` / `HOST_PORT`.
- Webhook hanya memproses invoice yang sudah **Sent** (Draft/Void dilewati; `&force=true` untuk memaksa).
- PDF Faktur Pajak disimpan di folder data, sehingga tombol 🔄 Sinkron bisa melampirkannya ulang jika kiriman pertama gagal.
- 🔄 Sinkron kini mengirim ulang XML (lampiran + field) **dan** data faktur sekaligus; lampiran & komentar tidak dobel.
- Setiap langkah (custom field, komentar, lampiran) berdiri sendiri: satu gagal tidak menghentikan yang lain; lampiran `.xml` otomatis dikirim sebagai `.xml.txt` jika Zoho menolak tipe XML.
- **Hasil XML dikirim balik ke Zoho**: custom field (mis. `cf_hasil_xml`) diisi link unduhan XML atau isi XML, plus lampiran file `.xml` di invoice. Tombol 🔄 Sinkron di dashboard mengirim ulang XML untuk log lama.

### 🔐 Security
- Parameter `accounts-server` dari callback divalidasi terhadap domain resmi Zoho sebelum client secret dikirim; `state` OAuth diverifikasi per sesi.

---

## [1.1.0] - 2026-11-06

### 🚀 Added
- **Sinkronisasi balik Coretax → Zoho Books**: Nomor Faktur Pajak, tanggal, dan status ditulis ke custom field invoice; komentar riwayat; lampiran PDF Faktur Pajak.
- Impor file ekspor Faktur Keluaran Coretax (XLSX/CSV) dengan pratinjau, pencocokan via kolom Referensi, dan deteksi baris yang tidak berubah.
- Input faktur manual per invoice dan tombol sinkron ulang di dashboard.
- Endpoint `POST /api/coretax-result` (autentikasi `X-API-Key`) untuk otomasi.
- Status "XML Dibuat" ditulis ke Zoho segera setelah XML terkirim.
- Klien Zoho Books API: refresh token OAuth dengan cache, retry otomatis untuk 401 / 429 / 5xx, dukungan multi data center.
- Halaman Pengaturan: kartu koneksi Zoho Books + tes koneksi & validasi custom field.
- Test otomatis (`npm test`) dengan mock Zoho API.

### 🐛 Fixed
- `VATRate` pada XML kode transaksi 04 kini **12** (DPP Nilai Lain 11/12 × PPN 12%, sesuai PMK 131/2024). Sebelumnya tertulis 11; nilai PPN tidak berubah.
- Menyimpan pengaturan SMTP tidak lagi menghapus field konfigurasi lain.
- Webhook ganda (mis. dipicu ulang oleh edit invoice) tidak lagi mengirim email/XML duplikat.
- Password SMTP pusat dan session secret dipindahkan dari kode ke `.env`.
- Akun yang di-suspend tidak bisa login ke dashboard.
- Penulisan `database.json` dibuat atomik.

### 🔐 Security
- Client secret, refresh token, dan password SMTP kustom dienkripsi AES-256-GCM.

---

## [1.0.0] - 2026-07-30

### 🚀 Added (Fitur Baru)
- **Core Engine**: Parser XML e-Faktur rilis CoreTax DJP.
- **Zoho Books API Connector**: Fitur auto-create Sales Invoice, auto-item mapping, dan tax code handling.
- **Multi-Tenant System**: Isolasi data konfigurasi Zoho API Key & Org ID per tenant.
- **Hybrid SMTP**: Dukungan multi-provider SMTP untuk pengiriman invoice/laporan e-Faktur ke email klien.
- **Superadmin Dashboard**: Control panel berbasis web untuk kelola tenant, reset credential, dan monitor log activity.
- **Security Layer**: Enkripsi simetris AES-256 untuk perlindungan data sensitif di `database.json`.

---

### 💡 Rencana Fitur Mendatang (Roadmap v1.1.0)
- Laporan analitik ringkasan PPN Keluar/Masuk bulanan.
- Fitur auto-retry saat koneksi Zoho API mengalami *rate limit*.
- Webhook trigger untuk integrasi aplikasi akuntansi lain (Jurnal, Accurate).