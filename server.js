const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const { create } = require('xmlbuilder2');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Setup Template Engine EJS
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Setup Session untuk Login User
app.use(session({
    secret: 'super-secret-key-efaktur-asta',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 24 * 60 * 60 * 1000 } // Aktif selama 24 jam
}));

const DB_FILE = path.join(__dirname, 'database.json');

// Helper untuk Operasi Database JSON
const readDB = () => JSON.parse(fs.readFileSync(DB_FILE));
const writeDB = (data) => fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));

// Inisialisasi Database Default jika Belum Tersedia
if (!fs.existsSync(DB_FILE)) {
    const defaultApiKey = 'asta_live_' + crypto.randomBytes(12).toString('hex');
    writeDB({
        users: [{ 
            id: 1, 
            username: 'admin', 
            password: '$2a$10$U/K3oD1Z0Xq.1v179K011eQ31X.N373rYI.y7p0B67qX82aMv.I5m', // password bawaan: admin
            apiKey: defaultApiKey,
            companyName: 'PT Asta Korpora Pusat',
            status: 'active',
            role: 'admin',
            config: { sellerTin: '', sellerTku: '', useCustomSmtp: false, smtpHost: '', smtpPort: 465, smtpUser: '', smtpPass: '', emailTarget: '' }
        }],
        logs: []
    });
}

// Global Config untuk SMTP Default (Server Pusat Anda)
const DEFAULT_SMTP = {
    host: "mail.astabumi.com",
    port: 587,
    secure: false,
    user: "noreply@astabumi.com",
    pass: "pwbaru123" // <-- Ganti dengan password email utama Anda
};

// Middleware Proteksi Halaman Dashboard & Settings
const requireAuth = (req, res, next) => {
    if (!req.session.isLoggedIn) return res.redirect('/login');
    next();
};

// Middleware Khusus Superadmin (Hanya user dengan username 'admin' atau role 'admin')
const requireAdmin = (req, res, next) => {
    if (!req.session.isLoggedIn || req.session.username !== 'admin') {
        return res.status(403).send('Akses ditolak. Halaman ini hanya untuk Superadmin.');
    }
    next();
};

// ================= ROUTING WEB INTERFACE (UI) =================

app.get('/', (req, res) => res.redirect('/dashboard'));

app.get('/login', (req, res) => {
    if (req.session.isLoggedIn) return res.redirect('/dashboard');
    res.render('login', { error: null });
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    const db = readDB();
    const user = db.users.find(u => u.username === username);

    if (user && bcrypt.compareSync(password, user.password)) {
        req.session.isLoggedIn = true;
        req.session.userId = user.id;
        req.session.username = username;
        return res.redirect('/dashboard');
    }
    res.render('login', { error: 'Username atau password salah!' });
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// Dashboard: Menampilkan log milik user yang sedang login
app.get('/dashboard', requireAuth, (req, res) => {
    const db = readDB();
    const userLogs = db.logs.filter(l => l.userId === req.session.userId).reverse();
    res.render('dashboard', { username: req.session.username, logs: userLogs });
});

// API Polling: Menghitung jumlah log real-time milik user spesifik
app.get('/api/logs/count', requireAuth, (req, res) => {
    const db = readDB();
    const count = db.logs.filter(l => l.userId === req.session.userId).length;
    res.json({ count });
});

// Endpoint untuk Download File XML dari Dashboard
app.get('/download-xml/:id', requireAuth, (req, res) => {
    const db = readDB();
    const log = db.logs.find(l => l.id === parseInt(req.params.id) && l.userId === req.session.userId);

    if (!log || !log.xmlData) return res.status(404).send('File XML tidak ditemukan.');

    res.setHeader('Content-disposition', `attachment; filename=efaktur-${log.invoiceNumber}.xml`);
    res.set('Content-Type', 'text/xml');
    res.status(200).send(log.xmlData);
});

// ================= ROUTING PENGATURAN (SETTINGS CLIENT) =================

app.get('/settings', requireAuth, (req, res) => {
    const db = readDB();
    const user = db.users.find(u => u.id === req.session.userId);
    res.render('settings', { user, success: null });
});

app.post('/settings/save', requireAuth, (req, res) => {
    const db = readDB();
    const userIndex = db.users.findIndex(u => u.id === req.session.userId);

    if (userIndex !== -1) {
        const useCustom = req.body.useCustomSmtp === 'true';
        
        db.users[userIndex].companyName = req.body.companyName;
        db.users[userIndex].config = {
            sellerTin: req.body.sellerTin.replace(/[^0-9]/g, ""),
            sellerTku: req.body.sellerTku.replace(/[^0-9]/g, ""),
            useCustomSmtp: useCustom,
            smtpHost: useCustom ? req.body.smtpHost : (db.users[userIndex].config.smtpHost || ''),
            smtpPort: useCustom ? (parseInt(req.body.smtpPort) || 465) : (db.users[userIndex].config.smtpPort || 465),
            smtpUser: useCustom ? req.body.smtpUser : (db.users[userIndex].config.smtpUser || ''),
            smtpPass: useCustom && req.body.smtpPass ? req.body.smtpPass : (db.users[userIndex].config.smtpPass || ''),
            emailTarget: req.body.emailTarget
        };
        writeDB(db);
    }
    res.render('settings', { user: db.users[userIndex], success: 'Konfigurasi berhasil disimpan!' });
});

app.post('/settings/regenerate-key', requireAuth, (req, res) => {
    const db = readDB();
    const userIndex = db.users.findIndex(u => u.id === req.session.userId);
    
    if (userIndex !== -1) {
        db.users[userIndex].apiKey = 'asta_live_' + crypto.randomBytes(12).toString('hex');
        writeDB(db);
    }
    res.redirect('/settings');
});

// Endpoint Tes Koneksi SMTP Kustom
app.post('/settings/test-smtp', requireAuth, async (req, res) => {
    const { smtpHost, smtpPort, smtpUser, smtpPass, emailTarget } = req.body;
    if (!smtpHost || !smtpPort || !smtpUser || !smtpPass || !emailTarget) {
        return res.status(400).json({ success: false, message: 'Semua kolom SMTP kustom dan email target wajib diisi.' });
    }
    try {
        let transporter = nodemailer.createTransport({
            host: smtpHost, port: parseInt(smtpPort) || 465, secure: parseInt(smtpPort) === 465,
            auth: { user: smtpUser, pass: smtpPass }
        });
        await transporter.verify();
        await transporter.sendMail({
            from: `"e-Faktur Gateway Test" <${smtpUser}>`, to: emailTarget,
            subject: `🚨 [TEST] Uji Coba Koneksi SMTP Kustom`,
            text: `Halo,\n\nEmail ini dikirim secara otomatis untuk memverifikasi bahwa konfigurasi Server SMTP Kustom Anda sudah berjalan dengan BENAR.\n\nSalam,\nSistem Automasi Gateway`
        });
        res.json({ success: true, message: 'Koneksi SMTP berhasil! Email uji coba telah dikirim ke ' + emailTarget });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Gagal menghubungkan ke SMTP: ' + error.message });
    }
});

// ================= ROUTING KHUSUS SUPERADMIN PANEL =================

// Halaman Manajemen User Utama
app.get('/superadmin', requireAdmin, (req, res) => {
    const db = readDB();
    // Kirim seluruh daftar user ke client UI kecuali password sensitif
    const clientsList = db.users.map(u => ({ id: u.id, username: u.username, companyName: u.companyName, apiKey: u.apiKey, status: u.status }));
    res.render('superadmin', { clients: clientsList, success: req.query.success || null, error: req.query.error || null });
});

// Proses Tambah Klien Baru
app.post('/superadmin/add-user', requireAdmin, (req, res) => {
    const { username, password, companyName } = req.body;
    const db = readDB();

    if (db.users.find(u => u.username === username)) {
        return res.redirect('/superadmin?error=Username sudah terdaftar!');
    }

    const newClient = {
        id: Date.now(),
        username: username,
        password: bcrypt.hashSync(password, 10),
        apiKey: 'asta_live_' + crypto.randomBytes(12).toString('hex'),
        companyName: companyName,
        status: 'active',
        config: { sellerTin: '', sellerTku: '', useCustomSmtp: false, smtpHost: '', smtpPort: 465, smtpUser: '', smtpPass: '', emailTarget: '' }
    };

    db.users.push(newClient);
    writeDB(db);
    res.redirect('/superadmin?success=Klien baru berhasil ditambahkan!');
});

// Proses Ubah Status Akun (Aktif / Suspend) atau Update Password (Reset)
app.post('/superadmin/update-user/:id', requireAdmin, (req, res) => {
    const userId = parseInt(req.params.id);
    const { status, newPassword } = req.body;
    const db = readDB();
    const userIndex = db.users.findIndex(u => u.id === userId);

    if (userIndex === -1) return res.redirect('/superadmin?error=User tidak ditemukan');
    if (db.users[userIndex].username === 'admin') return res.redirect('/superadmin?error=Akun utama admin tidak bisa dimodifikasi');

    // Ubah status jika dikirim
    if (status) db.users[userIndex].status = status;
    
    // Reset password jika diisi
    if (newPassword && newPassword.trim() !== "") {
        db.users[userIndex].password = bcrypt.hashSync(newPassword, 10);
    }

    writeDB(db);
    res.redirect('/superadmin?success=Data klien berhasil diperbarui!');
});

// ================= API WEBHOOK RECEIVER (ZOHO TO CORETAX) =================

app.post('/zoho-to-coretax', async (req, res) => {
    const apiKey = req.query.api_key;
    if (!apiKey) return res.status(401).send({ success: false, message: 'API Key is missing.' });

    const db = readDB();
    const client = db.users.find(u => u.apiKey === apiKey);
    
    if (!client) return res.status(401).send({ success: false, message: 'Invalid API Key.' });
    if (client.status !== 'active') return res.status(403).send({ success: false, message: 'Account is inactive. Please contact system admin.' });

    const config = client.config;
    const zohoInvoice = req.body.invoice;

    try {
        if (!zohoInvoice) return res.status(400).send({ success: false, message: 'Invalid payload' });

        const buyerNpwp = zohoInvoice.cf_npwp ? String(zohoInvoice.cf_npwp).replace(/[^0-9]/g, "") : "";
        const invoiceDate = zohoInvoice.date ? String(zohoInvoice.date).split('T')[0] : "";

        let totalVat = 0;
        const lineItems = (zohoInvoice.line_items || [])
            .filter(line => (line.rate || 0) > 0)
            .map(line => {
                const price = line.rate || 0; const qty = line.quantity || 0; const discount = line.discount || 0;
                const taxBase = (price * qty) - discount;
                const otherTaxBase = parseFloat((taxBase * 11 / 12).toFixed(2));
                const vatRate = line.tax_percentage || 11;
                const vat = parseFloat((taxBase * (vatRate / 100)).toFixed(2));
                totalVat += vat;
                const isService = line.item_type === "service";

                return {
                    Opt: isService ? "A" : "B", Code: "000000", Name: `- ${line.name || ''}`,
                    Unit: isService ? "UM.0018" : "UM.0033", Price: price, Qty: qty,
                    TotalDiscount: discount, TaxBase: taxBase, OtherTaxBase: otherTaxBase,
                    VATRate: vatRate, VAT: vat, STLGRate: 0, STLG: 0
                };
            });

        const doc = create({ version: '1.0', encoding: 'UTF-8', standalone: 'yes' })
            .ele('TaxInvoiceBulk', { 'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance', 'xsi:noNamespaceSchemaLocation': 'TaxInvoice.xsd' });

        doc.ele('TIN').txt(config.sellerTin);
        const listOfTaxInvoice = doc.ele('ListOfTaxInvoice');
        const taxInvoice = listOfTaxInvoice.ele('TaxInvoice');

        taxInvoice.ele('TaxInvoiceDate').txt(invoiceDate);
        taxInvoice.ele('TaxInvoiceOpt').txt("Normal"); taxInvoice.ele('TrxCode').txt("04"); taxInvoice.ele('RefDesc').txt(zohoInvoice.invoice_number || "");
        taxInvoice.ele('SellerIDTKU').txt(config.sellerTku); taxInvoice.ele('BuyerTin').txt(buyerNpwp); taxInvoice.ele('BuyerDocument').txt("TIN");
        taxInvoice.ele('BuyerCountry').txt("IND"); taxInvoice.ele('BuyerName').txt(zohoInvoice.customer_name || "");
        taxInvoice.ele('BuyerAdress').txt(zohoInvoice.billing_address ? zohoInvoice.billing_address.address : "");
        taxInvoice.ele('BuyerEmail').txt(zohoInvoice.email || ""); taxInvoice.ele('BuyerIDTKU').txt(buyerNpwp ? buyerNpwp + "000000" : "");

        const goodServiceList = taxInvoice.ele('ListOfGoodService');
        lineItems.forEach(item => {
            const gs = goodServiceList.ele('GoodService');
            gs.ele('Opt').txt(item.Opt); gs.ele('Code').txt(item.Code); gs.ele('Name').txt(item.Name);
            gs.ele('Unit').txt(item.Unit); gs.ele('Price').txt(String(item.Price)); gs.ele('Qty').txt(String(item.Qty));
            gs.ele('TotalDiscount').txt(String(item.TotalDiscount)); gs.ele('TaxBase').txt(String(item.TaxBase));
            gs.ele('OtherTaxBase').txt(String(item.OtherTaxBase)); gs.ele('VATRate').txt(String(item.VATRate));
            gs.ele('VAT').txt(String(item.VAT)); gs.ele('STLGRate').txt(String(item.STLGRate)); gs.ele('STLG').txt(String(item.STLG));
        });

        const xmlString = doc.end({ prettyPrint: true });

        // Pemilihan Jalur SMTP Pusat vs Kustom
        let smtpConfig, senderEmail;
        if (config.useCustomSmtp === true || config.useCustomSmtp === 'true') {
            smtpConfig = { host: config.smtpHost, port: config.smtpPort, secure: config.smtpPort === 465, auth: { user: config.smtpUser, pass: config.smtpPass } };
            senderEmail = config.smtpUser;
        } else {
            smtpConfig = { host: DEFAULT_SMTP.host, port: DEFAULT_SMTP.port, secure: DEFAULT_SMTP.secure, auth: { user: DEFAULT_SMTP.user, pass: DEFAULT_SMTP.pass } };
            senderEmail = DEFAULT_SMTP.user;
        }

        let transporter = nodemailer.createTransport(smtpConfig);
        await transporter.sendMail({
            from: `"${client.companyName} e-Faktur" <${senderEmail}>`, to: config.emailTarget,
            subject: `[Ready] XML e-Faktur: ${zohoInvoice.invoice_number}`,
            text: `Halo Tim Finansial,\n\nBerikut terlampir file XML e-Faktur hasil konversi otomatis dari Zoho Books untuk Invoice ${zohoInvoice.invoice_number}.\n\nSalam,\nSistem Automasi Gateway`,
            attachments: [{ filename: `efaktur-${zohoInvoice.invoice_number}.xml`, content: xmlString }]
        });

        const currentDB = readDB();
        currentDB.logs.push({ id: Date.now(), userId: client.id, timestamp: new Date().toLocaleString('id-ID'), invoiceNumber: zohoInvoice.invoice_number, customerName: zohoInvoice.customer_name, totalAmount: zohoInvoice.total, totalVat: parseFloat(totalVat.toFixed(2)), xmlData: xmlString, status: 'Success' });
        writeDB(currentDB);

        res.status(200).send({ success: true, message: 'Processed successfully!' });
    } catch (error) {
        console.error(error);
        const currentDB = readDB();
        currentDB.logs.push({ id: Date.now(), userId: client.id, timestamp: new Date().toLocaleString('id-ID'), invoiceNumber: req.body.invoice ? req.body.invoice.invoice_number : 'UNKNOWN', customerName: req.body.invoice ? req.body.invoice.customer_name : 'UNKNOWN', totalAmount: req.body.invoice ? req.body.invoice.total : 0, totalVat: 0, status: error.message });
        writeDB(currentDB);
        res.status(500).send({ success: false, error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Gateway SaaS e-Faktur aktif pada port ${PORT}`));