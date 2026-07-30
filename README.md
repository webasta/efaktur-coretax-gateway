# SaaS e-Faktur CoreTax Gateway & Auto-Sync Zoho Books

Sistem Gateway SaaS Multi-Tenant untuk otomatisasi parsing, enkripsi/dekripsi password, konversi XML CoreTax e-Faktur, integrasi Sales Invoice Zoho Books, serta pengiriman email otomatis via SMTP Hybrid.

---

## 🚀 Fitur Utama

- **Multi-Tenant Architecture**: Pemisahan data kredensial dan API key antar klien (Asta Korpora, dsb).
- **CoreTax XML Converter**: Ekstraksi dan konversi data XML e-Faktur CoreTax ke format yang kompatibel dengan Zoho Books API.
- **Zoho Books Integration**: Otomatisasi pembuatan *Sales Invoice*, penyesuaian tax code, serta penanganan *customer lookup*.
- **Hybrid SMTP Engine**: Fleksibilitas pengiriman email notifikasi via SMTP pihak ketiga (SendGrid, Mailgun, AWS SES, atau Custom SMTP).
- **Superadmin Control Panel**: Interface manajemen tenant, registrasi API Key, monitoring kuota, dan audit log transaksi.
- **Security & Encryption**: Enkripsi password database lokal dan API Key sensitif menggunakan AES-256 GCM.

---

## 🛠️ Prasyarat & Teknologi

- **Runtime**: Node.js (v18+ LTS recommended)
- **Process Manager**: PM2
- **Web Server / Reverse Proxy**: Nginx
- **Database**: Encrypted JSON Store (`database.json`)

---

## ⚙️ Instalasi & Konfigurasi

1. **Clone Repository**
   ```bash
   git clone [https://github.com/USERNAME/efaktur-coretax-gateway.git](https://github.com/USERNAME/efaktur-coretax-gateway.git)
   cd efaktur-coretax-gateway