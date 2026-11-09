// Konfigurasi aplikasi dari environment variable (.env).
// Node >= 20.12 punya process.loadEnvFile bawaan, jadi tidak perlu paket dotenv.
const path = require('path');

try {
    process.loadEnvFile(path.join(__dirname, '..', '.env'));
} catch (_) {
    // .env opsional: variabel bisa juga diset langsung oleh PM2 / systemd.
}

const env = process.env;

module.exports = {
    port: parseInt(env.PORT, 10) || 3000,
    // URL publik gateway, dipakai untuk menampilkan Webhook URL di halaman Pengaturan.
    publicBaseUrl: (env.PUBLIC_BASE_URL || 'https://efaktur.astakorpora.com').replace(/\/+$/, ''),
    sessionSecret: env.SESSION_SECRET || 'ganti-session-secret-di-env',
    // Kunci enkripsi AES-256-GCM untuk kredensial sensitif (client secret, refresh token, password SMTP).
    appSecret: env.APP_SECRET || '',
    dataDir: env.DATA_DIR || path.join(__dirname, '..'),
    // Aplikasi OAuth "Server-based" milik gateway (untuk tombol "Hubungkan ke Zoho Books").
    // Kosong = tombol tidak tampil, tenant memakai mode Self Client manual.
    zohoOAuth: {
        clientId: env.ZOHO_CLIENT_ID || '',
        clientSecret: env.ZOHO_CLIENT_SECRET || ''
    },
    defaultSmtp: {
        host: env.SMTP_HOST || '',
        port: parseInt(env.SMTP_PORT, 10) || 587,
        secure: env.SMTP_SECURE === 'true',
        user: env.SMTP_USER || '',
        pass: env.SMTP_PASS || ''
    }
};
