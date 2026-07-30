# Changelog

Semua perubahan penting pada project **SaaS e-Faktur CoreTax Gateway** akan dicatat di file ini.

Format changelog ini mengacu pada [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) dan project ini menerapkan [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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