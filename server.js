const config = require('./lib/config');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const nodemailer = require('nodemailer');

const db = require('./lib/db');
const { encrypt, decrypt } = require('./lib/secret');
const { buildXml, invoiceFingerprint, getCustomField } = require('./lib/efaktur');
const zoho = require('./lib/zoho');
const { ZohoBooksClient, DATA_CENTERS, clearCaches } = zoho;
const crypto = require('crypto');
const { parseCoretaxExport } = require('./lib/coretaxImport');
const sync = require('./lib/sync');
const stages = require('./lib/stages');
const fs = require('fs');

const app = express();
// Limit dinaikkan karena upload file Coretax / PDF faktur dikirim sebagai base64 di body JSON.
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true }));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Helper tampilan yang dipakai semua template
app.locals.ui = require('./lib/ui');

app.set('trust proxy', 1); // di belakang Nginx
app.use(session({
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax' }
}));

db.init();
const { readDB, updateDB } = db;

// Nomor invoice seperti 019/ASM-HQ/XI/2026 tidak boleh dipakai mentah sebagai nama file.
const { xmlFileBase } = require('./lib/stages');

const nowLabel = () => new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });

// ================= MIDDLEWARE =================

const requireAuth = (req, res, next) => {
    if (!req.session.isLoggedIn) {
        if (req.path.startsWith('/api/') || req.xhr || req.is('json')) return res.status(401).json({ success: false, message: 'Sesi berakhir, silakan login ulang.' });
        return res.redirect('/login');
    }
    next();
};

const requireAdmin = (req, res, next) => {
    if (!req.session.isLoggedIn || req.session.username !== 'admin') {
        return res.status(403).send('Akses ditolak. Halaman ini hanya untuk Superadmin.');
    }
    next();
};

// Autentikasi API Key (dipakai webhook Zoho dan API hasil Coretax). Bisa via ?api_key= atau header X-API-Key.
const requireApiKey = (req, res, next) => {
    const apiKey = req.query.api_key || req.get('x-api-key');
    if (!apiKey) return res.status(401).send({ success: false, message: 'API Key is missing.' });
    const client = readDB().users.find(u => u.apiKey === apiKey);
    if (!client) return res.status(401).send({ success: false, message: 'Invalid API Key.' });
    if (client.status !== 'active') return res.status(403).send({ success: false, message: 'Account is inactive. Please contact system admin.' });
    req.client = client;
    next();
};

const currentUser = (req) => readDB().users.find(u => u.id === req.session.userId);

// Data Zoho yang aman untuk ditampilkan di form (tanpa secret).
const zohoView = (zoho) => ({
    ...zoho,
    clientSecret: '',
    refreshToken: '',
    hasClientSecret: !!zoho.clientSecret,
    hasRefreshToken: !!zoho.refreshToken
});

const renderSettings = (res, user, extra = {}) => res.render('settings', {
    user: { ...user, zoho: zohoView(user.zoho) },
    username: user.username, companyName: user.companyName, active: 'settings',
    success: null, error: null, dataCenters: DATA_CENTERS, publicBaseUrl: config.publicBaseUrl,
    oauthAvailable: zoho.oauthEnabled(), ...extra
});

// ================= ROUTING WEB INTERFACE (UI) =================

app.get('/', (req, res) => res.redirect('/dashboard'));

app.get('/login', (req, res) => {
    if (req.session.isLoggedIn) return res.redirect('/dashboard');
    res.render('login', { error: null });
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    const user = readDB().users.find(u => u.username === username);

    if (user && user.status === 'active' && bcrypt.compareSync(password || '', user.password)) {
        return req.session.regenerate(() => {
            req.session.isLoggedIn = true;
            req.session.userId = user.id;
            req.session.username = username;
            res.redirect('/dashboard');
        });
    }
    res.render('login', { error: 'Username atau password salah!' });
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/login'));
});

// Ringkasan log untuk tampilan (tanpa isi XML yang besar).
const logView = (l) => {
    const { xmlData, fingerprint, xmlToken, ...rest } = l;
    const f = l.faktur || {};
    return {
        ...rest,
        hasXml: !!xmlData,
        hasPdfFile: !!(f.pdfFile && fs.existsSync(path.join(config.dataDir, 'files', f.pdfFile))),
        date: stages.formatDate(l.id),
        stage: stages.stageOf(l),
        statusInfo: stages.statusOf(l)
    };
};

// Data umum untuk semua halaman (sidebar + badge jumlah).
const pageData = (req, page, extra = {}) => {
    const user = currentUser(req);
    const userLogs = readDB().logs.filter(l => l.userId === req.session.userId);
    const groups = stages.groupLogs(userLogs);
    return {
        page,
        active: page,
        username: req.session.username,
        companyName: user ? user.companyName : '',
        zohoEnabled: !!(user && user.zoho && user.zoho.enabled),
        counts: {
            pending: groups.pending.length, completed: groups.completed.length,
            revised: groups.pending.filter(l => l.revision).length,
            failed: userLogs.filter(l => l.status !== 'Success').length
        },
        userLogs, groups,
        ...extra
    };
};

const RANGES = [7, 30, 90];
const parseRange = (v) => (RANGES.includes(parseInt(v, 10)) ? parseInt(v, 10) : 30);

app.get('/dashboard', requireAuth, (req, res) => {
    const range = parseRange(req.query.range);
    const d = pageData(req, 'dashboard');
    res.render('dashboard', {
        ...d,
        range, ranges: RANGES,
        stats: stages.buildStats(d.userLogs, range),
        recentPending: d.groups.pending.slice(0, 5).map(logView)
    });
});

app.get('/pending', requireAuth, (req, res) => {
    const d = pageData(req, 'pending');
    res.render('pending', { ...d, rows: d.groups.pending.map(logView) });
});

app.get('/completed', requireAuth, (req, res) => {
    const d = pageData(req, 'completed');
    res.render('completed', { ...d, rows: d.groups.completed.map(logView) });
});

app.get('/riwayat', requireAuth, (req, res) => {
    const range = req.query.range === 'all' ? 'all' : parseRange(req.query.range);
    const d = pageData(req, 'riwayat');
    const start = range === 'all' ? 0 : Date.now() - range * 86400000;
    const rows = d.userLogs.filter(l => l.id >= start).sort((a, b) => b.id - a.id).slice(0, 1000).map(logView);
    res.render('riwayat', { ...d, rows, range, ranges: RANGES });
});

// Unduh PDF Faktur Pajak yang diunggah lewat gateway.
app.get('/logs/:id/faktur-pdf', requireAuth, (req, res) => {
    const log = readDB().logs.find(l => l.id === parseInt(req.params.id, 10) && l.userId === req.session.userId);
    const f = (log && log.faktur) || {};
    const file = f.pdfFile && /^[\w.-]+$/.test(f.pdfFile) ? path.join(config.dataDir, 'files', f.pdfFile) : null;
    if (!file || !fs.existsSync(file)) return res.status(404).send('PDF Faktur Pajak tidak tersimpan di gateway (lihat lampiran invoice di Zoho Books).');
    const name = (f.pdfName || `FP-${f.number || log.invoiceNumber}.pdf`).replace(/[^\w.-]+/g, '_');
    res.setHeader('Content-disposition', `attachment; filename="${name}"`);
    res.set('Content-Type', 'application/pdf');
    res.status(200).send(fs.readFileSync(file));
});

// Tandai XML sudah / belum diunggah ke Coretax (memindahkan invoice antar tahap).
app.post('/logs/:id/coretax', requireAuth, (req, res) => {
    const logId = parseInt(req.params.id, 10);
    const uploaded = req.body.uploaded !== false && req.body.uploaded !== 'false';
    const log = updateDB(d => {
        const l = d.logs.find(x => x.id === logId && x.userId === req.session.userId);
        if (!l) return null;
        if (uploaded) l.coretaxUploadedAt = nowLabel();
        else { delete l.coretaxUploadedAt; delete l.xmlDownloadedAt; }
        return l;
    });
    if (!log) return res.status(404).json({ success: false, message: 'Log tidak ditemukan' });
    res.json({ success: true, stage: stages.stageOf(log) });
});

// Polling dashboard: berubah jika ada log baru ATAU status sinkron berubah.
app.get('/api/logs/count', requireAuth, (req, res) => {
    const logs = readDB().logs.filter(l => l.userId === req.session.userId);
    const version = logs.reduce((acc, l) => acc + (l.zohoSync ? l.zohoSync.at + l.zohoSync.state : '') +
        (l.faktur ? l.faktur.number + l.faktur.hasPdf : '') + (l.coretaxUploadedAt || '') + (l.xmlDownloadedAt || ''), '');
    res.json({ count: logs.length, version: require('crypto').createHash('md5').update(version).digest('hex') });
});

app.get('/download-xml/:id', requireAuth, (req, res) => {
    const log = readDB().logs.find(l => l.id === parseInt(req.params.id, 10) && l.userId === req.session.userId);
    if (!log || !log.xmlData) return res.status(404).send('File XML tidak ditemukan.');
    if (!log.xmlDownloadedAt) {
        updateDB(d => { const l = d.logs.find(x => x.id === log.id); if (l) l.xmlDownloadedAt = nowLabel(); });
    }
    res.setHeader('Content-disposition', `attachment; filename="${xmlFileBase(log)}.xml"`);
    res.set('Content-Type', 'text/xml');
    res.status(200).send(log.xmlData);
});

// Link unduhan XML yang dicantumkan di custom field Zoho (token acak, tanpa login).
app.get('/xml/:token', (req, res) => {
    const token = String(req.params.token || '');
    if (!/^[a-f0-9]{32}$/.test(token)) return res.status(404).send('Tidak ditemukan.');
    const log = readDB().logs.find(l => l.xmlToken === token && l.xmlData);
    if (!log) return res.status(404).send('Tidak ditemukan.');
    res.setHeader('Content-disposition', `attachment; filename="${xmlFileBase(log)}.xml"`);
    res.set('Content-Type', 'text/xml');
    res.set('X-Robots-Tag', 'noindex');
    res.status(200).send(log.xmlData);
});

// ================= ROUTING PENGATURAN (SETTINGS CLIENT) =================

app.get('/settings', requireAuth, (req, res) => {
    renderSettings(res, currentUser(req), { success: req.query.success || null, error: req.query.error || null });
});

app.post('/settings/save', requireAuth, (req, res) => {
    const user = updateDB(d => {
        const u = d.users.find(x => x.id === req.session.userId);
        if (!u) return null;
        const useCustom = req.body.useCustomSmtp === 'true';
        const prev = u.config || db.defaultConfig();
        u.companyName = req.body.companyName;
        // Merge (bukan ganti total) supaya field lain tidak hilang.
        u.config = {
            ...prev,
            sellerTin: String(req.body.sellerTin || '').replace(/[^0-9]/g, ''),
            sellerTku: String(req.body.sellerTku || '').replace(/[^0-9]/g, ''),
            useCustomSmtp: useCustom,
            smtpHost: useCustom ? req.body.smtpHost : (prev.smtpHost || ''),
            smtpPort: useCustom ? (parseInt(req.body.smtpPort, 10) || 465) : (prev.smtpPort || 465),
            smtpUser: useCustom ? req.body.smtpUser : (prev.smtpUser || ''),
            smtpPass: useCustom && req.body.smtpPass ? encrypt(req.body.smtpPass) : (prev.smtpPass || ''),
            emailTarget: req.body.emailTarget
        };
        return u;
    });
    renderSettings(res, user, { success: 'Konfigurasi berhasil disimpan!' });
});

app.post('/settings/regenerate-key', requireAuth, (req, res) => {
    updateDB(d => {
        const u = d.users.find(x => x.id === req.session.userId);
        if (u) u.apiKey = db.newApiKey();
    });
    res.redirect('/settings');
});

app.post('/settings/test-smtp', requireAuth, async (req, res) => {
    const { smtpHost, smtpPort, smtpUser, emailTarget } = req.body;
    // Jika password dikosongkan di form, pakai password tersimpan.
    const stored = currentUser(req).config || {};
    const smtpPass = req.body.smtpPass || decrypt(stored.smtpPass);
    if (!smtpHost || !smtpPort || !smtpUser || !smtpPass || !emailTarget) {
        return res.status(400).json({ success: false, message: 'Semua kolom SMTP kustom dan email target wajib diisi.' });
    }
    try {
        const transporter = nodemailer.createTransport({
            host: smtpHost, port: parseInt(smtpPort, 10) || 465, secure: parseInt(smtpPort, 10) === 465,
            auth: { user: smtpUser, pass: smtpPass }
        });
        await transporter.verify();
        await transporter.sendMail({
            from: `"e-Faktur Gateway Test" <${smtpUser}>`, to: emailTarget,
            subject: '🚨 [TEST] Uji Coba Koneksi SMTP Kustom',
            text: 'Halo,\n\nEmail ini dikirim secara otomatis untuk memverifikasi bahwa konfigurasi Server SMTP Kustom Anda sudah berjalan dengan BENAR.\n\nSalam,\nSistem Automasi Gateway'
        });
        res.json({ success: true, message: 'Koneksi SMTP berhasil! Email uji coba telah dikirim ke ' + emailTarget });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Gagal menghubungkan ke SMTP: ' + error.message });
    }
});

// --- Pengaturan koneksi balik ke Zoho Books ---

app.post('/settings/zoho', requireAuth, (req, res) => {
    const b = req.body;
    updateDB(d => {
        const u = d.users.find(x => x.id === req.session.userId);
        if (!u) return;
        const prev = { ...db.defaultZohoConfig(), ...(u.zoho || {}) };
        const field = (v) => String(v || '').trim();
        const next = {
            ...prev,
            enabled: b.zohoEnabled === 'true',
            fieldFakturNumber: field(b.fieldFakturNumber),
            fieldFakturDate: field(b.fieldFakturDate),
            fieldFakturStatus: field(b.fieldFakturStatus),
            fieldXml: field(b.fieldXml),
            xmlFieldMode: b.xmlFieldMode === 'content' ? 'content' : 'link',
            attachXml: b.attachXml === 'true',
            markOnXmlGenerated: b.markOnXmlGenerated === 'true',
            addComment: b.addComment === 'true',
            attachPdf: b.attachPdf === 'true'
        };

        if (b.useSelfClient === 'true') {
            // Mode lanjutan: Self Client manual
            const switching = prev.authMode !== 'self';
            Object.assign(next, {
                authMode: 'self',
                dataCenter: DATA_CENTERS.includes(b.dataCenter) ? b.dataCenter : 'com',
                accountsServer: '', apiDomain: '',
                organizationId: field(b.selfOrganizationId),
                organizationName: '',
                clientId: field(b.clientId),
                // Secret hanya diganti jika diisi; kosong = pertahankan yang lama (selama mode tidak berganti).
                clientSecret: b.clientSecret ? encrypt(field(b.clientSecret)) : (switching ? '' : prev.clientSecret),
                refreshToken: b.refreshToken ? encrypt(field(b.refreshToken)) : (switching ? '' : prev.refreshToken)
            });
        } else if (prev.authMode === 'oauth' && b.organizationId) {
            // Mode OAuth: hanya boleh memilih organisasi dari daftar hasil koneksi
            const org = (prev.organizations || []).find(o => o.id === b.organizationId);
            if (org) Object.assign(next, { organizationId: org.id, organizationName: org.name });
        }
        u.zoho = next;
    });
    clearCaches();
    res.redirect('/settings?success=' + encodeURIComponent('Pengaturan Zoho Books berhasil disimpan!') + '#zoho');
});

// --- OAuth: tombol "Hubungkan ke Zoho Books" ---

const settingsRedirect = (res, kind, msg) => res.redirect(`/settings?${kind}=${encodeURIComponent(msg)}#zoho`);

app.get('/zoho/connect', requireAuth, (req, res) => {
    if (!zoho.oauthEnabled()) return settingsRedirect(res, 'error', 'Koneksi OAuth belum dikonfigurasi admin (ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET).');
    const state = crypto.randomBytes(16).toString('hex');
    req.session.zohoOAuth = { state, userId: req.session.userId, at: Date.now() };
    req.session.save(() => res.redirect(zoho.buildAuthorizeUrl(state)));
});

app.get('/zoho/oauth/callback', requireAuth, async (req, res) => {
    const pending = req.session.zohoOAuth;
    delete req.session.zohoOAuth;
    const { code, state, error } = req.query;

    if (error) {
        return settingsRedirect(res, 'error', error === 'access_denied' ? 'Akses ditolak di halaman Zoho.' : 'Zoho mengembalikan error: ' + error);
    }
    if (!pending || pending.state !== state || pending.userId !== req.session.userId || Date.now() - pending.at > 10 * 60_000) {
        return settingsRedirect(res, 'error', 'Sesi koneksi Zoho tidak valid atau kedaluwarsa. Silakan klik Hubungkan lagi.');
    }
    if (!code) return settingsRedirect(res, 'error', 'Kode otorisasi dari Zoho tidak ada.');

    try {
        const token = await zoho.exchangeCode({ code, accountsServer: req.query['accounts-server'] });
        const draft = {
            ...db.defaultZohoConfig(), authMode: 'oauth',
            refreshToken: encrypt(token.refreshToken),
            accountsServer: token.accountsServer, apiDomain: token.apiDomain,
            dataCenter: zoho.dataCenterFromApiDomain(token.apiDomain)
        };
        const orgs = await new ZohoBooksClient(draft).listOrganizations();
        if (!orgs.length) throw new Error('Akun Zoho ini belum memiliki organisasi Zoho Books.');
        const chosen = orgs.find(o => o.isDefault) || orgs[0];

        const previous = currentUser(req).zoho;
        updateDB(d => {
            const u = d.users.find(x => x.id === req.session.userId);
            const prev = { ...db.defaultZohoConfig(), ...(u.zoho || {}) };
            u.zoho = {
                ...prev,
                enabled: true,
                authMode: 'oauth',
                clientId: '', clientSecret: '',
                refreshToken: draft.refreshToken,
                accountsServer: draft.accountsServer,
                apiDomain: draft.apiDomain,
                dataCenter: draft.dataCenter,
                organizations: orgs.map(({ id, name }) => ({ id, name })),
                organizationId: chosen.id,
                organizationName: chosen.name,
                connectedAt: nowLabel()
            };
        });
        // Cabut refresh token lama milik aplikasi gateway agar tidak menumpuk (Zoho membatasi jumlahnya).
        if (previous && previous.authMode === 'oauth' && previous.refreshToken && previous.refreshToken !== draft.refreshToken) {
            zoho.revokeRefreshToken(previous).catch(() => {});
        }
        clearCaches();
        const extra = orgs.length > 1 ? ` (${orgs.length} organisasi ditemukan, ganti di pilihan Organisasi bila perlu)` : '';
        settingsRedirect(res, 'success', `Terhubung ke Zoho Books: ${chosen.name}${extra}`);
    } catch (err) {
        console.error('Zoho OAuth callback:', err.message);
        settingsRedirect(res, 'error', 'Gagal menghubungkan Zoho Books: ' + err.message);
    }
});

app.post('/zoho/disconnect', requireAuth, async (req, res) => {
    const user = currentUser(req);
    if (user.zoho && user.zoho.authMode === 'oauth') await zoho.revokeRefreshToken(user.zoho);
    updateDB(d => {
        const u = d.users.find(x => x.id === req.session.userId);
        u.zoho = {
            ...u.zoho, enabled: false, refreshToken: '', accountsServer: '', apiDomain: '',
            organizations: [], organizationId: '', organizationName: '', connectedAt: ''
        };
    });
    clearCaches();
    settingsRedirect(res, 'success', 'Koneksi Zoho Books diputus.');
});

app.post('/settings/zoho/test', requireAuth, async (req, res) => {
    const user = currentUser(req);
    try {
        clearCaches();
        const client = new ZohoBooksClient(user.zoho);
        const org = await client.testConnection();
        const wanted = [user.zoho.fieldFakturNumber, user.zoho.fieldFakturDate, user.zoho.fieldFakturStatus, user.zoho.fieldXml].filter(Boolean);
        const fields = await client.listInvoiceCustomFields(true);
        const has = (name) => fields.some(f => f.api_name === name || f.placeholder === name);
        const missing = wanted.filter(n => !has(n));
        const xmlField = fields.find(f => user.zoho.fieldXml && (f.api_name === user.zoho.fieldXml || f.placeholder === user.zoho.fieldXml));
        const xmlWarn = '';
        const xmlInfo = xmlField && zoho.isFileFieldType(xmlField.data_type)
            ? ` ${user.zoho.fieldXml} bertipe ${xmlField.data_type}: akan diisi file XML.` : '';
        res.json({
            success: missing.length === 0 && !xmlWarn,
            message: `Terhubung ke organisasi "${org.name || user.zoho.organizationId}".` +
                (missing.length ? ` Custom field belum ada di Zoho: ${missing.join(', ')}` : ' Semua custom field ditemukan.') + xmlWarn + xmlInfo,
            availableFields: fields.map(f => ({ api_name: f.api_name || f.placeholder, label: f.label, data_type: f.data_type }))
        });
    } catch (err) {
        res.status(400).json({ success: false, message: err.message });
    }
});

// ================= ARAH BALIK: CORETAX -> ZOHO BOOKS =================

// Input manual nomor faktur untuk satu invoice (opsional + PDF faktur dalam base64).
app.post('/logs/:id/faktur', requireAuth, async (req, res) => {
    const logId = parseInt(req.params.id, 10);
    const log = readDB().logs.find(l => l.id === logId && l.userId === req.session.userId);
    if (!log) return res.status(404).json({ success: false, message: 'Log tidak ditemukan' });

    const { fakturNumber, fakturDate, status, pdfBase64, pdfFilename } = req.body;
    if (!fakturNumber) return res.status(400).json({ success: false, message: 'Nomor faktur wajib diisi' });
    const pdf = pdfBase64 ? { filename: pdfFilename, buffer: Buffer.from(String(pdfBase64).split(',').pop(), 'base64') } : null;

    const r = await sync.pushFakturToZoho(req.session.userId, logId, {
        fakturNumber, fakturDate, status: status || 'Approved', source: 'input manual', pdf
    });
    res.status(r.ok || r.pending ? 200 : 502).json({ success: r.ok, pending: !!r.pending, message: r.message });
});

// Kirim ulang data faktur yang tersimpan ke Zoho (mis. setelah memperbaiki konfigurasi).
app.post('/logs/:id/resync', requireAuth, async (req, res) => {
    const logId = parseInt(req.params.id, 10);
    const log = readDB().logs.find(l => l.id === logId && l.userId === req.session.userId);
    if (!log) return res.status(404).json({ success: false, message: 'Log tidak ditemukan' });
    const r = await sync.resyncLog(req.session.userId, logId);
    res.status(r.ok || r.pending ? 200 : 502).json({ success: r.ok, pending: !!r.pending, message: r.message });
});

// Impor file ekspor Faktur Keluaran dari Coretax (CSV/XLSX).
// Body: { filename, contentBase64, dryRun: true|false, force: bool }
app.post('/coretax/import', requireAuth, async (req, res) => {
    try {
        const { filename, contentBase64, dryRun, force } = req.body;
        if (!contentBase64) return res.status(400).json({ success: false, message: 'File belum dipilih' });
        const buffer = Buffer.from(String(contentBase64).split(',').pop(), 'base64');
        const parsed = parseCoretaxExport(buffer, filename);
        const matched = sync.matchRecords(req.session.userId, parsed.records);
        if (dryRun !== false) {
            return res.json({ success: true, dryRun: true, columns: parsed.columns, records: matched });
        }
        const results = await sync.applyRecords(req.session.userId, matched, { force: !!force });
        res.json({
            success: true, dryRun: false, records: results,
            summary: {
                synced: results.filter(r => r.ok && r.action !== 'unchanged').length,
                unchanged: results.filter(r => r.action === 'unchanged').length,
                failed: results.filter(r => !r.ok && r.action !== 'skip').length,
                skipped: results.filter(r => r.action === 'skip').length
            }
        });
    } catch (err) {
        res.status(400).json({ success: false, message: err.message });
    }
});

// API untuk otomasi (RPA / PJAP / script) yang membawa hasil Coretax.
// Body: { results: [{ invoice_number, faktur_number, faktur_date, status, pdf_base64?, pdf_filename? }] }
//   atau satu objek tunggal dengan field yang sama.
app.post('/api/coretax-result', requireApiKey, async (req, res) => {
    const items = Array.isArray(req.body.results) ? req.body.results : [req.body];
    const out = [];
    for (const it of items) {
        const reference = String(it.invoice_number || it.reference || '').trim();
        const fakturNumber = String(it.faktur_number || '').replace(/[^0-9]/g, '');
        if (!reference || !fakturNumber) { out.push({ invoice_number: reference, success: false, message: 'invoice_number dan faktur_number wajib' }); continue; }

        const [m] = sync.matchRecords(req.client.id, [{ reference, fakturNumber, fakturDate: it.faktur_date || '', status: it.status || 'Approved', warning: '' }]);
        if (m.action === 'unchanged' && !it.pdf_base64) { out.push({ invoice_number: reference, success: true, message: m.note }); continue; }

        let logId = m.logId;
        if (!logId) {
            const [r] = await sync.applyRecords(req.client.id, [m]);
            out.push({ invoice_number: reference, success: r.ok, message: r.message });
            continue;
        }
        const pdf = it.pdf_base64 ? { filename: it.pdf_filename, buffer: Buffer.from(String(it.pdf_base64).split(',').pop(), 'base64') } : null;
        const r = await sync.pushFakturToZoho(req.client.id, logId, {
            fakturNumber, fakturDate: m.fakturDate, status: m.status, source: 'API', pdf
        });
        out.push({ invoice_number: reference, success: r.ok, message: r.message });
    }
    const allOk = out.every(o => o.success);
    res.status(allOk ? 200 : 207).json({ success: allOk, results: out });
});

// ================= ROUTING KHUSUS SUPERADMIN PANEL =================

app.get('/superadmin', requireAdmin, (req, res) => {
    const clientsList = readDB().users.map(u => ({
        id: u.id, username: u.username, companyName: u.companyName, apiKey: u.apiKey, status: u.status,
        zohoEnabled: !!(u.zoho && u.zoho.enabled)
    }));
    res.render('superadmin', { clients: clientsList, success: req.query.success || null, error: req.query.error || null });
});

app.post('/superadmin/add-user', requireAdmin, (req, res) => {
    const { username, password, companyName } = req.body;
    if (!username || !password) return res.redirect('/superadmin?error=Username dan password wajib diisi!');
    const exists = readDB().users.find(u => u.username === username);
    if (exists) return res.redirect('/superadmin?error=Username sudah terdaftar!');

    updateDB(d => d.users.push({
        id: Date.now(),
        username,
        password: bcrypt.hashSync(password, 10),
        apiKey: db.newApiKey(),
        companyName,
        status: 'active',
        config: db.defaultConfig(),
        zoho: db.defaultZohoConfig()
    }));
    res.redirect('/superadmin?success=Klien baru berhasil ditambahkan!');
});

app.post('/superadmin/update-user/:id', requireAdmin, (req, res) => {
    const userId = parseInt(req.params.id, 10);
    const { status, newPassword } = req.body;
    const err = updateDB(d => {
        const u = d.users.find(x => x.id === userId);
        if (!u) return 'User tidak ditemukan';
        if (u.username === 'admin') return 'Akun utama admin tidak bisa dimodifikasi';
        if (status) u.status = status;
        if (newPassword && newPassword.trim() !== '') u.password = bcrypt.hashSync(newPassword, 10);
        return null;
    });
    if (err) return res.redirect('/superadmin?error=' + encodeURIComponent(err));
    res.redirect('/superadmin?success=Data klien berhasil diperbarui!');
});

// ================= API WEBHOOK RECEIVER (ZOHO TO CORETAX) =================

const smtpFor = (client) => {
    const c = client.config;
    if (c.useCustomSmtp === true || c.useCustomSmtp === 'true') {
        return {
            transport: { host: c.smtpHost, port: c.smtpPort, secure: Number(c.smtpPort) === 465, auth: { user: c.smtpUser, pass: decrypt(c.smtpPass) } },
            sender: c.smtpUser
        };
    }
    const s = config.defaultSmtp;
    if (!s.host || !s.user) throw new Error('SMTP pusat belum dikonfigurasi (SMTP_HOST/SMTP_USER di .env)');
    return { transport: { host: s.host, port: s.port, secure: s.secure, auth: { user: s.user, pass: s.pass } }, sender: s.user };
};

app.post('/zoho-to-coretax', requireApiKey, async (req, res) => {
    const client = req.client;
    const zohoInvoice = req.body.invoice;
    if (!zohoInvoice) return res.status(400).send({ success: false, message: 'Invalid payload' });

    // --- Hanya invoice yang sudah dikirim (Sent) ---
    // Draft belum final dan Void dibatalkan, jadi tidak dibuatkan faktur.
    const invStatus = String(zohoInvoice.status || '').toLowerCase();
    if (['draft', 'void'].includes(invStatus) && req.query.force !== 'true') {
        return res.status(200).send({ success: true, skipped: true, message: `Invoice berstatus ${invStatus}, XML dibuat setelah invoice berstatus Sent.` });
    }

    // --- Idempotensi ---
    // 1) Invoice yang sudah punya nomor faktur pajak tidak diproses ulang.
    const fakturField = client.zoho && client.zoho.fieldFakturNumber;
    if (fakturField && String(getCustomField(zohoInvoice, fakturField) || '').trim()) {
        return res.status(200).send({ success: true, skipped: true, message: 'Invoice sudah memiliki nomor Faktur Pajak, dilewati.' });
    }
    // 2) Webhook berulang dengan isi invoice yang sama (mis. terpicu karena gateway meng-update
    //    custom field di Zoho) tidak membuat XML & email ganda.
    const fingerprint = invoiceFingerprint(zohoInvoice);
    const duplicate = readDB().logs.find(l => l.userId === client.id && l.status === 'Success' &&
        l.fingerprint === fingerprint &&
        ((zohoInvoice.invoice_id && l.zohoInvoiceId === String(zohoInvoice.invoice_id)) || l.invoiceNumber === zohoInvoice.invoice_number));
    if (duplicate && req.query.force !== 'true') {
        return res.status(200).send({ success: true, skipped: true, message: 'Isi invoice tidak berubah sejak XML terakhir, dilewati.' });
    }

    // Nomor revisi: 0 = XML pertama, 1 = revisi pertama, dst. (versi sebelumnya tetap disimpan)
    const previous = readDB().logs.filter(l => l.userId === client.id && l.status === 'Success' && l.xmlData &&
        ((zohoInvoice.invoice_id && l.zohoInvoiceId === String(zohoInvoice.invoice_id)) || l.invoiceNumber === zohoInvoice.invoice_number));
    const revision = previous.length ? Math.max(...previous.map(l => l.revision || 0)) + 1 : 0;
    const revLabel = revision ? ` (Revisi ${revision})` : '';

    const logBase = {
        userId: client.id,
        revision,
        invoiceNumber: zohoInvoice.invoice_number,
        zohoInvoiceId: zohoInvoice.invoice_id ? String(zohoInvoice.invoice_id) : '',
        customerName: zohoInvoice.customer_name,
        totalAmount: zohoInvoice.total
    };

    try {
        const { xml, totalVat } = buildXml(zohoInvoice, client.config);
        const { transport, sender } = smtpFor(client);

        await nodemailer.createTransport(transport).sendMail({
            from: `"${client.companyName} e-Faktur" <${sender}>`, to: client.config.emailTarget,
            subject: `[Ready] XML e-Faktur: ${zohoInvoice.invoice_number}${revLabel}`,
            text: `Halo Tim Finansial,\n\nBerikut terlampir file XML e-Faktur hasil konversi otomatis dari Zoho Books untuk Invoice ${zohoInvoice.invoice_number}${revLabel}.\n\n${revision ? 'Invoice ini DIREVISI di Zoho Books. Jika XML versi sebelumnya sudah diunggah ke Coretax, hapus draft faktur lama di Coretax sebelum mengunggah XML ini.\n\n' : ''}Setelah faktur di-approve di Coretax, unggah file ekspor Faktur Keluaran (atau isi nomor faktur) di dashboard gateway agar nomor faktur tercatat kembali di Zoho Books.\n\nSalam,\nSistem Automasi Gateway`,
            attachments: [{ filename: `${xmlFileBase({ invoiceNumber: zohoInvoice.invoice_number, revision })}.xml`, content: xml }]
        });

        const logId = Date.now();
        updateDB(d => d.logs.push({
            id: logId, ...logBase, timestamp: nowLabel(), totalVat, xmlData: xml, fingerprint, status: 'Success'
        }));

        // Arah balik langsung: tandai "XML Dibuat" di Zoho (tidak menggagalkan webhook bila error).
        sync.pushXmlToZoho(client.id, logId).catch(e => console.error('pushXmlToZoho:', e.message));

        res.status(200).send({ success: true, message: 'Processed successfully!' });
    } catch (error) {
        console.error(error);
        updateDB(d => d.logs.push({ id: Date.now(), ...logBase, timestamp: nowLabel(), totalVat: 0, status: error.message }));
        res.status(500).send({ success: false, error: error.message });
    }
});

if (require.main === module) {
    app.listen(config.port, () => console.log(`Gateway SaaS e-Faktur aktif pada port ${config.port}`));
}

module.exports = app;
