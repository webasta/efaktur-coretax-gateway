// Penyimpanan JSON sederhana. Penulisan dibuat atomik (tulis ke file sementara lalu rename)
// supaya database.json tidak korup jika proses mati di tengah penulisan.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

const DB_FILE = path.join(config.dataDir, 'database.json');

const defaultConfig = () => ({
    sellerTin: '', sellerTku: '',
    padNpwp15: true,            // NPWP 15 digit (format lama) otomatis jadi 16 digit dengan '0' di depan
    useCustomSmtp: false, smtpHost: '', smtpPort: 465, smtpUser: '', smtpPass: '', emailTarget: ''
});

const defaultZohoConfig = () => ({
    enabled: false,
    authMode: 'self',           // 'oauth' = tombol Hubungkan, 'self' = Self Client manual
    dataCenter: 'com',          // com | eu | in | com.au | jp | ca | sa | com.cn
    accountsServer: '',         // diisi otomatis dari callback OAuth (mis. https://accounts.zoho.com)
    apiDomain: '',              // diisi otomatis dari token response (mis. https://www.zohoapis.com)
    organizationId: '',
    organizationName: '',
    organizations: [],          // daftar organisasi Zoho Books yang bisa dipilih
    connectedAt: '',
    clientId: '',
    clientSecret: '',           // terenkripsi
    refreshToken: '',           // terenkripsi
    fieldFakturNumber: 'cf_nomor_faktur_pajak',
    fieldFakturDate: 'cf_tanggal_faktur_pajak',
    fieldFakturStatus: 'cf_status_e_faktur',
    fieldXml: '',               // mis. cf_hasil_xml — diisi link unduhan XML atau isi XML
    xmlFieldMode: 'link',       // 'link' | 'content'
    attachXml: true,            // lampirkan file .xml ke invoice Zoho
    markOnXmlGenerated: true,   // isi status "XML Dibuat" di Zoho saat XML berhasil dikirim
    addComment: true,           // tambahkan komentar riwayat di invoice Zoho
    attachPdf: true             // lampirkan PDF Faktur Pajak bila diunggah
});

const defaultAirtableConfig = () => ({
    enabled: false,
    token: '',                  // Personal Access Token (terenkripsi)
    baseId: '', baseName: '',
    tableId: '', tableName: '',
    fields: { match: '', fakturNumber: '', fakturDate: '', fakturStatus: '', pdf: '', xml: '' }, // field ID
    createIfMissing: false      // buat record baru jika invoice belum ada di Airtable
});

const readDB = () => JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));

const writeDB = (data) => {
    const tmp = DB_FILE + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, DB_FILE);
};

// Baca-ubah-tulis dalam satu langkah sinkron, jadi tidak ada request lain yang menyela.
const updateDB = (mutator) => {
    const db = readDB();
    const result = mutator(db);
    writeDB(db);
    return result;
};

const newApiKey = () => 'asta_live_' + crypto.randomBytes(12).toString('hex');

const init = () => {
    if (!fs.existsSync(DB_FILE)) {
        writeDB({
            users: [{
                id: 1,
                username: 'admin',
                password: '$2a$10$U/K3oD1Z0Xq.1v179K011eQ31X.N373rYI.y7p0B67qX82aMv.I5m', // password bawaan: admin
                apiKey: newApiKey(),
                companyName: 'PT Asta Korpora Pusat',
                status: 'active',
                role: 'admin',
                config: defaultConfig(),
                zoho: defaultZohoConfig(),
                airtable: defaultAirtableConfig()
            }],
            logs: []
        });
        return;
    }
    // Migrasi ringan: lengkapi field baru pada database lama.
    updateDB(db => {
        db.logs = db.logs || [];
        db.users.forEach(u => {
            u.config = { ...defaultConfig(), ...(u.config || {}) };
            u.zoho = { ...defaultZohoConfig(), ...(u.zoho || {}) };
            const at = { ...defaultAirtableConfig(), ...(u.airtable || {}) };
            at.fields = { ...defaultAirtableConfig().fields, ...(at.fields || {}) };
            u.airtable = at;
        });
    });
};

module.exports = { readDB, writeDB, updateDB, init, newApiKey, defaultConfig, defaultZohoConfig, defaultAirtableConfig, DB_FILE };
