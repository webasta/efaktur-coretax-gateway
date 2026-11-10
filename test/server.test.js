// Uji alur lengkap di level route: Zoho -> XML -> email, lalu Coretax -> Zoho.
// Express & modul npm lain diganti stub sehingga handler bisa dipanggil langsung.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const h = require('./helpers');

const dataDir = h.tmpDataDir();
process.env.SMTP_HOST = 'smtp.test';
process.env.SMTP_USER = 'noreply@test';
process.env.ZOHO_CLIENT_ID = 'app-cid';
process.env.ZOHO_CLIENT_SECRET = 'app-secret';
process.env.PUBLIC_BASE_URL = 'https://gw.test';

const sentMails = [];
const routes = [];
const fakeExpress = () => {
    const app = {
        locals: {}, use() {}, set() {}, listen() {},
        get: (p, ...hs) => routes.push({ method: 'GET', path: p, hs }),
        post: (p, ...hs) => routes.push({ method: 'POST', path: p, hs })
    };
    return app;
};
fakeExpress.json = () => (q, s, n) => n();
fakeExpress.urlencoded = () => (q, s, n) => n();

h.installStubs({
    express: () => fakeExpress,
    'express-session': () => () => (q, s, n) => n(),
    bcryptjs: () => ({ hashSync: (p) => 'h:' + p, compareSync: (p, hash) => hash === 'h:' + p }),
    nodemailer: () => ({ createTransport: () => ({ sendMail: async (m) => { sentMails.push(m); }, verify: async () => true }) }),
    xmlbuilder2: h.xmlbuilderStub
}, ['express', 'express-session', 'bcryptjs', 'nodemailer']);

const mock = h.createZohoMock();
globalThis.fetch = mock.fetchImpl;

require('../server');
const db = require('../lib/db');

// Pemanggil route sederhana
const call = (method, url, { body = {}, session = {}, headers = {} } = {}) => new Promise((resolve, reject) => {
    const u = new URL(url, 'http://x');
    const route = routes.find(r => {
        if (r.method !== method) return false;
        const re = new RegExp('^' + r.path.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$');
        return re.test(u.pathname);
    });
    if (!route) return reject(new Error('route tidak ada: ' + method + ' ' + url));
    const params = new RegExp('^' + route.path.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$').exec(u.pathname).groups || {};
    const req = {
        method, path: u.pathname, params, body, session, headers,
        query: Object.fromEntries(u.searchParams),
        get: (k) => headers[k.toLowerCase()],
        is: () => true
    };
    const res = {
        statusCode: 200,
        status(c) { this.statusCode = c; return this; },
        json(b) { resolve({ status: this.statusCode, body: b }); },
        send(b) { resolve({ status: this.statusCode, body: b }); },
        redirect(l) { resolve({ status: 302, location: l }); },
        render(view, data) { resolve({ status: this.statusCode, view, data }); },
        setHeader() {}, set() {}
    };
    let i = 0;
    const next = () => {
        const fn = route.hs[i++];
        Promise.resolve(fn(req, res, next)).catch(reject);
    };
    next();
});

const tick = () => new Promise(r => setTimeout(r, 30));
const admin = () => db.readDB().users[0];
const session = () => ({ isLoggedIn: true, userId: 1, username: 'admin', save(cb) { cb(); } });

const zohoInvoice = (over = {}) => ({
    invoice_id: '5001', invoice_number: 'INV-000101', date: '2026-11-03', customer_name: 'PT Pembeli A',
    cf_npwp: '0012345678901000', total: 1110000, email: 'a@pembeli.id',
    billing_address: { address: 'Jl. Contoh 1' },
    line_items: [{ name: 'Jasa', rate: 1000000, quantity: 1, item_type: 'service', tax_percentage: 11 }],
    ...over
});

test('setup tenant: simpan konfigurasi pajak + koneksi Zoho (secret terenkripsi, config lain tidak hilang)', async () => {
    await call('POST', '/settings/save', {
        session: session(),
        body: { companyName: 'PT Asta', sellerTin: '0800.1952.9907.7000', sellerTku: '0800195299077000000000', emailTarget: 'fin@asta.id' }
    });
    const r = await call('POST', '/settings/zoho', {
        session: session(),
        body: {
            zohoEnabled: 'true', useSelfClient: 'true', dataCenter: 'com', selfOrganizationId: 'ORG1', clientId: 'cid', clientSecret: 'csecret', refreshToken: 'refresh-ok',
            fieldFakturNumber: 'cf_nomor_faktur_pajak', fieldFakturDate: 'cf_tanggal_faktur_pajak', fieldFakturStatus: 'cf_status_e_faktur',
            markOnXmlGenerated: 'true', addComment: 'true', attachPdf: 'true'
        }
    });
    assert.strictEqual(r.status, 302);
    const u = admin();
    assert.strictEqual(u.config.sellerTin, '0800195299077000');
    assert.ok(u.zoho.refreshToken.startsWith('enc:v1:'));
    assert.ok(!fs.readFileSync(path.join(dataDir, 'database.json'), 'utf8').includes('refresh-ok'));

    // Simpan ulang SMTP tidak boleh menghapus koneksi Zoho
    await call('POST', '/settings/save', { session: session(), body: { companyName: 'PT Asta', sellerTin: '0800195299077000', sellerTku: '0800195299077000000000', emailTarget: 'fin@asta.id' } });
    assert.strictEqual(admin().zoho.organizationId, 'ORG1');

    // Simpan form Zoho dengan secret kosong = pertahankan secret lama
    await call('POST', '/settings/zoho', { session: session(), body: { zohoEnabled: 'true', useSelfClient: 'true', selfOrganizationId: 'ORG1', clientId: 'cid', fieldFakturNumber: 'cf_nomor_faktur_pajak', fieldFakturDate: 'cf_tanggal_faktur_pajak', fieldFakturStatus: 'cf_status_e_faktur', markOnXmlGenerated: 'true', addComment: 'true', attachPdf: 'true' } });
    assert.ok(admin().zoho.refreshToken.startsWith('enc:v1:'));

    const t = await call('POST', '/settings/zoho/test', { session: session() });
    assert.strictEqual(t.body.success, true, t.body.message);
    assert.match(t.body.message, /PT Contoh/);

    const page = await call('GET', '/settings', { session: session() });
    assert.strictEqual(page.data.user.zoho.refreshToken, '');
    assert.strictEqual(page.data.user.zoho.hasRefreshToken, true);
});

test('arah 1: webhook Zoho -> XML + email, lalu status "XML Dibuat" tertulis di Zoho', async () => {
    const key = admin().apiKey;
    const r = await call('POST', `/zoho-to-coretax?api_key=${key}`, { body: { invoice: zohoInvoice() } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(sentMails.length, 1);
    assert.match(sentMails[0].attachments[0].content, /<VATRate>12<\/VATRate>/);
    await tick();
    const log = db.readDB().logs.at(-1);
    assert.strictEqual(log.zohoInvoiceId, '5001');
    assert.strictEqual(log.zohoSync.state, 'xml_marked');
    assert.strictEqual(mock.state.invoices['5001'].custom.cf_status_e_faktur, 'XML Dibuat');
});

test('anti-loop: webhook ulang dengan isi sama (terpicu update gateway) dilewati, tanpa email ganda', async () => {
    const key = admin().apiKey;
    const r = await call('POST', `/zoho-to-coretax?api_key=${key}`, { body: { invoice: zohoInvoice({ cf_status_e_faktur: 'XML Dibuat' }) } });
    assert.strictEqual(r.body.skipped, true);
    assert.strictEqual(sentMails.length, 1);

    // Isi berubah (revisi invoice) -> XML baru dibuat
    const r2 = await call('POST', `/zoho-to-coretax?api_key=${key}`, { body: { invoice: zohoInvoice({ total: 2220000, line_items: [{ name: 'Jasa', rate: 2000000, quantity: 1, item_type: 'service' }] }) } });
    assert.strictEqual(r2.body.success, true);
    assert.ok(!r2.body.skipped);
    assert.strictEqual(sentMails.length, 2);

    // Invoice lain
    await call('POST', `/zoho-to-coretax?api_key=${key}`, { body: { invoice: zohoInvoice({ invoice_id: '5002', invoice_number: 'INV-000102', customer_name: 'PT Pembeli B' }) } });
    assert.strictEqual(sentMails.length, 3);
    await tick();
});

test('arah 2: impor ekspor Coretax (XLSX) -> pratinjau lalu kirim ke Zoho', async () => {
    const content = fs.readFileSync(path.join(__dirname, 'fixtures', 'coretax-export-sample.xlsx')).toString('base64');
    const preview = await call('POST', '/coretax/import', { session: session(), body: { filename: 'export.xlsx', contentBase64: content } });
    assert.strictEqual(preview.body.success, true, preview.body.message);
    assert.deepStrictEqual(preview.body.records.map(r => r.action), ['sync', 'sync', 'lookup', 'skip']);
    // Pratinjau tidak mengubah Zoho
    assert.strictEqual(mock.state.invoices['5001'].custom.cf_nomor_faktur_pajak, undefined);

    const applied = await call('POST', '/coretax/import', { session: session(), body: { filename: 'export.xlsx', contentBase64: content, dryRun: false } });
    assert.deepStrictEqual(applied.body.summary, { synced: 3, unchanged: 0, failed: 0, skipped: 1 });

    const inv = mock.state.invoices['5001'];
    assert.strictEqual(inv.custom.cf_nomor_faktur_pajak, '04002600000000101');
    assert.strictEqual(inv.custom.cf_tanggal_faktur_pajak, '2026-11-03');
    assert.strictEqual(inv.custom.cf_status_e_faktur, 'APPROVED');
    assert.match(inv.comments[0], /04002600000000101/);
    // Invoice yang dibuat di luar gateway dicari lewat nomor invoice
    assert.strictEqual(mock.state.invoices['5099'].custom.cf_nomor_faktur_pajak, '04002600000000199');

    // Log terbaru INV-000101 (revisi) yang diperbarui
    const logs = db.readDB().logs.filter(l => l.invoiceNumber === 'INV-000101' && l.status === 'Success');
    assert.strictEqual(logs.at(-1).faktur.number, '04002600000000101');
    assert.strictEqual(logs.at(-1).zohoSync.state, 'synced');

    // Impor ulang file yang sama -> tidak ada yang dikirim ulang
    const again = await call('POST', '/coretax/import', { session: session(), body: { filename: 'export.xlsx', contentBase64: content, dryRun: false } });
    assert.strictEqual(again.body.summary.synced, 0);
    assert.strictEqual(again.body.summary.unchanged, 3);
    assert.strictEqual(inv.comments.length, 1);
});

test('webhook untuk invoice yang sudah bernomor faktur dilewati', async () => {
    const r = await call('POST', `/zoho-to-coretax?api_key=${admin().apiKey}`, {
        body: { invoice: zohoInvoice({ total: 999, cf_nomor_faktur_pajak: '04002600000000101' }) }
    });
    assert.strictEqual(r.body.skipped, true);
});

test('input manual + PDF dan sinkron ulang', async () => {
    const log = db.readDB().logs.filter(l => l.invoiceNumber === 'INV-000102').at(-1);
    const pdf = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4 faktur').toString('base64');
    const r = await call('POST', `/logs/${log.id}/faktur`, {
        session: session(),
        body: { fakturNumber: '04002600000000555', fakturDate: '2026-11-06', status: 'Amended', pdfBase64: pdf, pdfFilename: 'FP.pdf' }
    });
    assert.strictEqual(r.body.success, true, r.body.message);
    const inv = mock.state.invoices['5002'];
    assert.strictEqual(inv.custom.cf_nomor_faktur_pajak, '04002600000000555');
    assert.strictEqual(inv.custom.cf_status_e_faktur, 'Amended');
    assert.deepStrictEqual(inv.attachments.map(a => a.name), ['FP.pdf']);

    const rs = await call('POST', `/logs/${log.id}/resync`, { session: session() });
    assert.strictEqual(rs.body.success, true);

    // Log milik tenant lain tidak bisa disentuh
    const other = await call('POST', `/logs/${log.id}/faktur`, { session: { ...session(), userId: 999 }, body: { fakturNumber: '1' } });
    assert.strictEqual(other.status, 404);
});

test('API hasil Coretax (X-API-Key) untuk otomasi', async () => {
    const r = await call('POST', '/api/coretax-result', {
        headers: { 'x-api-key': admin().apiKey },
        body: { results: [
            { invoice_number: 'INV-000102', faktur_number: '040.026-00.000000777', faktur_date: '2026-11-06', status: 'APPROVED' },
            { invoice_number: 'INV-TIDAK-ADA', faktur_number: '04002600000000888' },
            { invoice_number: '', faktur_number: '1' }
        ] }
    });
    assert.strictEqual(r.status, 207);
    assert.deepStrictEqual(r.body.results.map(x => x.success), [true, false, false]);
    assert.strictEqual(mock.state.invoices['5002'].custom.cf_nomor_faktur_pajak, '04002600000000777');
    assert.match(r.body.results[1].message, /tidak ditemukan/);

    const bad = await call('POST', '/api/coretax-result', { headers: { 'x-api-key': 'salah' }, body: {} });
    assert.strictEqual(bad.status, 401);
});

test('error Zoho tercatat di log dan bisa disinkron ulang setelah diperbaiki', async () => {
    const log = db.readDB().logs.find(l => l.invoiceNumber === 'INV-000101' && l.faktur);
    db.updateDB(d => { d.users[0].zoho.fieldFakturStatus = 'cf_salah'; });
    require('../lib/zoho').clearCaches();
    const r = await call('POST', `/logs/${log.id}/resync`, { session: session() });
    assert.strictEqual(r.status, 502);
    assert.match(r.body.message, /cf_salah/);
    assert.strictEqual(db.readDB().logs.find(l => l.id === log.id).zohoSync.state, 'failed');

    db.updateDB(d => { d.users[0].zoho.fieldFakturStatus = 'cf_status_e_faktur'; });
    const ok = await call('POST', `/logs/${log.id}/resync`, { session: session() });
    assert.strictEqual(ok.body.success, true);
});

test('Zoho dinonaktifkan: nomor faktur tetap tersimpan, status tertunda', async () => {
    db.updateDB(d => { d.users[0].zoho.enabled = false; });
    const log = db.readDB().logs.find(l => l.invoiceNumber === 'INV-000101' && l.faktur);
    const r = await call('POST', `/logs/${log.id}/faktur`, { session: session(), body: { fakturNumber: '04002600000000999' } });
    assert.strictEqual(r.body.pending, true);
    const after = db.readDB().logs.find(l => l.id === log.id);
    assert.strictEqual(after.faktur.number, '04002600000000999');
    assert.strictEqual(after.zohoSync.state, 'pending');
    db.updateDB(d => { d.users[0].zoho.enabled = true; });
});

test('OAuth "Hubungkan ke Zoho Books": connect -> Accept -> callback otomatis', async () => {
    const sess = session();
    const go = await call('GET', '/zoho/connect', { session: sess });
    const auth = new URL(go.location);
    assert.strictEqual(auth.origin, 'https://accounts.zoho.com');
    assert.strictEqual(auth.searchParams.get('client_id'), 'app-cid');
    assert.strictEqual(auth.searchParams.get('access_type'), 'offline');
    assert.strictEqual(auth.searchParams.get('redirect_uri'), 'https://gw.test/zoho/oauth/callback');
    const state = auth.searchParams.get('state');

    // state salah ditolak
    const forged = await call('GET', '/zoho/oauth/callback?code=code-ok&state=palsu', { session: { ...sess, zohoOAuth: { state, userId: 1, at: Date.now() } } });
    assert.match(decodeURIComponent(forged.location), /tidak valid/);

    // accounts-server palsu tidak boleh menerima client secret
    const before = (mock.state.tokenHosts || []).length;
    const ok = await call('GET', `/zoho/oauth/callback?code=code-ok&state=${state}&location=us&accounts-server=${encodeURIComponent('https://evil.example')}`, { session: sess });
    assert.match(decodeURIComponent(ok.location), /success=Terhubung ke Zoho Books: PT Contoh/);
    const hosts = mock.state.tokenHosts.slice(before);
    assert.ok(hosts.length > 0 && hosts.every(h2 => h2 === 'https://accounts.zoho.com'), hosts.join());

    const z = admin().zoho;
    assert.strictEqual(z.authMode, 'oauth');
    assert.strictEqual(z.enabled, true);
    assert.strictEqual(z.organizationId, 'ORG1');      // organisasi default terpilih otomatis
    assert.strictEqual(z.organizations.length, 2);
    assert.strictEqual(z.clientSecret, '');
    assert.ok(z.refreshToken.startsWith('enc:v1:'));

    // Sinkron tetap jalan dengan kredensial aplikasi
    const t = await call('POST', '/settings/zoho/test', { session: session() });
    assert.strictEqual(t.body.success, true, t.body.message);

    // Simpan form (mapping) tidak mengubah koneksi; ganti organisasi hanya dari daftar
    await call('POST', '/settings/zoho', { session: session(), body: { zohoEnabled: 'true', organizationId: 'ORG0', fieldFakturNumber: 'cf_nomor_faktur_pajak', fieldFakturDate: 'cf_tanggal_faktur_pajak', fieldFakturStatus: 'cf_status_e_faktur' } });
    assert.strictEqual(admin().zoho.organizationName, 'PT Lain');
    await call('POST', '/settings/zoho', { session: session(), body: { zohoEnabled: 'true', organizationId: 'HACK', fieldFakturNumber: 'cf_nomor_faktur_pajak' } });
    assert.strictEqual(admin().zoho.organizationId, 'ORG0');
    assert.strictEqual(admin().zoho.authMode, 'oauth');

    // Halaman pengaturan tampil
    const page = await call('GET', '/settings', { session: session() });
    assert.strictEqual(page.data.oauthAvailable, true);

    // Ditolak user di layar Zoho
    const denied = await call('GET', '/zoho/oauth/callback?error=access_denied', { session: session() });
    assert.match(decodeURIComponent(denied.location), /Akses ditolak/);

    // Putuskan -> token dicabut
    await call('POST', '/zoho/disconnect', { session: session() });
    assert.ok(mock.state.revoked.includes('refresh-ok'));
    assert.strictEqual(admin().zoho.enabled, false);
    assert.strictEqual(admin().zoho.refreshToken, '');
});

test('hasil XML dikirim ke Zoho: cf_hasil_xml berisi link, file .xml dilampirkan sekali, link bisa diunduh', async () => {
    // sambung ulang via self client (test OAuth di atas memutus koneksi)
    db.updateDB(d => Object.assign(d.users[0].zoho, h.zohoConfig({ authMode: 'self', fieldXml: 'cf_hasil_xml', xmlFieldMode: 'link', attachXml: true })));
    require('../lib/zoho').clearCaches();
    mock.state.invoices['5003'] = { invoice_id: '5003', invoice_number: 'INV-000103', custom: {}, comments: [], attachments: [] };

    const r = await call('POST', `/zoho-to-coretax?api_key=${admin().apiKey}`, {
        body: { invoice: zohoInvoice({ invoice_id: '5003', invoice_number: 'INV-000103' }) }
    });
    assert.strictEqual(r.body.success, true);
    await tick();

    const inv = mock.state.invoices['5003'];
    assert.strictEqual(inv.custom.cf_status_e_faktur, 'XML Dibuat');
    assert.match(inv.custom.cf_hasil_xml, /^https:\/\/gw\.test\/xml\/[a-f0-9]{32}$/);
    assert.deepStrictEqual(inv.attachments.map(a => [a.name, a.type]), [['efaktur-INV-000103.xml', 'application/xml']]);

    const log = db.readDB().logs.filter(l => l.invoiceNumber === 'INV-000103').at(-1);
    assert.strictEqual(log.zohoSync.state, 'xml_marked');
    assert.match(log.zohoSync.message, /cf_hasil_xml \(link\)/);

    // Link unduhan publik
    const token = inv.custom.cf_hasil_xml.split('/').pop();
    const dl = await call('GET', `/xml/${token}`);
    assert.match(dl.body, /<RefDesc>INV-000103<\/RefDesc>/);
    assert.strictEqual((await call('GET', '/xml/00000000000000000000000000000000')).status, 404);

    // Sinkron ulang: tidak melampirkan file kedua, link tetap sama
    const rs = await call('POST', `/logs/${log.id}/resync`, { session: session() });
    assert.strictEqual(rs.body.success, true, rs.body.message);
    assert.strictEqual(inv.attachments.length, 1);
    assert.strictEqual(inv.custom.cf_hasil_xml.split('/').pop(), token);
});

test('mode isi XML: ditulis utuh, atau otomatis jadi link jika Zoho menolak karena terlalu panjang', async () => {
    db.updateDB(d => Object.assign(d.users[0].zoho, { xmlFieldMode: 'content', attachXml: false }));
    const log = db.readDB().logs.filter(l => l.invoiceNumber === 'INV-000103').at(-1);
    const inv = mock.state.invoices['5003'];

    await call('POST', `/logs/${log.id}/resync`, { session: session() });
    assert.match(inv.custom.cf_hasil_xml, /^<\?xml/);

    mock.state.maxFieldLength = 255;
    const r = await call('POST', `/logs/${log.id}/resync`, { session: session() });
    assert.strictEqual(r.body.success, true, r.body.message);
    assert.match(inv.custom.cf_hasil_xml, /^https:\/\/gw\.test\/xml\//);
    assert.match(r.body.message, /diganti link/);
    mock.state.maxFieldLength = undefined;
});

test('alur Sent: draft dilewati, Sent -> XML dilampirkan walau custom field gagal', async () => {
    db.updateDB(d => Object.assign(d.users[0].zoho, { fieldXml: 'cf_hasil_xml', xmlFieldMode: 'link', attachXml: true, fieldFakturStatus: 'cf_status_e_faktur' }));
    mock.state.invoices['5004'] = { invoice_id: '5004', invoice_number: 'INV-000104', custom: {}, comments: [], attachments: [] };
    const key = admin().apiKey;
    const mails = sentMails.length;

    const draft = await call('POST', `/zoho-to-coretax?api_key=${key}`, { body: { invoice: zohoInvoice({ invoice_id: '5004', invoice_number: 'INV-000104', status: 'draft' }) } });
    assert.strictEqual(draft.body.skipped, true);
    assert.strictEqual(sentMails.length, mails);

    // custom field "rusak" (seperti kasus JSON not well formed) -> lampiran XML tetap masuk
    db.updateDB(d => { d.users[0].zoho.fieldFakturStatus = 'cf_belum_dibuat'; });
    require('../lib/zoho').clearCaches();
    const sent = await call('POST', `/zoho-to-coretax?api_key=${key}`, { body: { invoice: zohoInvoice({ invoice_id: '5004', invoice_number: 'INV-000104', status: 'sent' }) } });
    assert.strictEqual(sent.body.success, true);
    await tick();
    const inv = mock.state.invoices['5004'];
    assert.deepStrictEqual(inv.attachments.map(a => a.name), ['efaktur-INV-000104.xml']);
    const log = db.readDB().logs.filter(l => l.invoiceNumber === 'INV-000104').at(-1);
    assert.strictEqual(log.zohoSync.state, 'failed');
    assert.match(log.zohoSync.message, /lampiran XML.*Gagal: custom field/);

    // Setelah field diperbaiki, Sinkron melengkapi field tanpa melampirkan XML kedua kali
    db.updateDB(d => { d.users[0].zoho.fieldFakturStatus = 'cf_status_e_faktur'; });
    require('../lib/zoho').clearCaches();
    const rs = await call('POST', `/logs/${log.id}/resync`, { session: session() });
    assert.strictEqual(rs.body.success, true, rs.body.message);
    assert.strictEqual(inv.attachments.length, 1);
    assert.strictEqual(inv.custom.cf_status_e_faktur, 'XML Dibuat');
    assert.match(inv.custom.cf_hasil_xml, /\/xml\//);
});

test('upload faktur + PDF: PDF disimpan dan tetap terlampir lewat Sinkron walau kiriman pertama gagal', async () => {
    const log = db.readDB().logs.filter(l => l.invoiceNumber === 'INV-000104').at(-1);
    const inv = mock.state.invoices['5004'];
    const pdf = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4 faktur 104').toString('base64');

    // Kiriman pertama: custom field gagal -> PDF & komentar tetap jalan
    db.updateDB(d => { d.users[0].zoho.fieldFakturNumber = 'cf_salah'; });
    require('../lib/zoho').clearCaches();
    const r1 = await call('POST', `/logs/${log.id}/faktur`, { session: session(), body: { fakturNumber: '04002600000000104', fakturDate: '2026-11-09', status: 'Created', pdfBase64: pdf, pdfFilename: 'FP-104.pdf' } });
    assert.strictEqual(r1.body.success, false);
    assert.deepStrictEqual(inv.attachments.map(a => a.name), ['efaktur-INV-000104.xml', 'FP-104.pdf']);
    assert.strictEqual(inv.comments.length, 1);

    // Sinkron setelah diperbaiki: field terisi, PDF & komentar tidak dobel, XML tidak dobel
    db.updateDB(d => { d.users[0].zoho.fieldFakturNumber = 'cf_nomor_faktur_pajak'; });
    require('../lib/zoho').clearCaches();
    const r2 = await call('POST', `/logs/${log.id}/resync`, { session: session() });
    assert.strictEqual(r2.body.success, true, r2.body.message);
    assert.strictEqual(inv.custom.cf_nomor_faktur_pajak, '04002600000000104');
    assert.strictEqual(inv.custom.cf_status_e_faktur, 'Created'); // status faktur tidak ditimpa "XML Dibuat"
    assert.strictEqual(inv.attachments.length, 2);
    assert.strictEqual(inv.comments.length, 1);
    assert.ok(fs.existsSync(path.join(dataDir, 'files', `${log.id}-faktur.pdf`)));

    // PDF baru diunggah -> dilampirkan lagi (file baru)
    await call('POST', `/logs/${log.id}/faktur`, { session: session(), body: { fakturNumber: '04002600000000104', fakturDate: '2026-11-09', status: 'Approved', pdfBase64: pdf, pdfFilename: 'FP-104-rev.pdf' } });
    assert.deepStrictEqual(inv.attachments.map(a => a.name).slice(-1), ['FP-104-rev.pdf']);
    assert.strictEqual(inv.comments.length, 2); // status berubah -> komentar baru
});

test('cf_hasil_xml bertipe Attachment: diisi file XML (document_id), tanpa lampiran dobel', async () => {
    const f = mock.state.fields.find(x => x.api_name === 'cf_hasil_xml');
    f.data_type = 'attachment';
    require('../lib/zoho').clearCaches();
    mock.state.invoices['5005'] = { invoice_id: '5005', invoice_number: 'INV-000105', custom: {}, comments: [], attachments: [] };
    await call('POST', `/zoho-to-coretax?api_key=${admin().apiKey}`, { body: { invoice: zohoInvoice({ invoice_id: '5005', invoice_number: 'INV-000105', status: 'sent' }) } });
    await tick();
    const inv = mock.state.invoices['5005'];
    assert.strictEqual(inv.attachments.length, 1);
    assert.strictEqual(inv.custom.cf_hasil_xml, inv.attachments[0].document_id);
    assert.strictEqual(inv.custom.cf_status_e_faktur, 'XML Dibuat');
    const log = db.readDB().logs.filter(l => l.invoiceNumber === 'INV-000105').at(-1);
    assert.strictEqual(log.zohoSync.state, 'xml_marked', log.zohoSync.message);
    assert.match(log.zohoSync.message, /cf_hasil_xml \(file XML\)/);

    // Sinkron ulang: tidak upload lagi
    await call('POST', `/logs/${log.id}/resync`, { session: session() });
    assert.strictEqual(inv.attachments.length, 1);

    const t = await call('POST', '/settings/zoho/test', { session: session() });
    assert.match(t.body.message, /akan diisi file XML/);
});

test('kasus lama: XML sudah terlampir sebelum fitur ini & respons tanpa documents -> document_id dicari, tidak upload ulang', async () => {
    mock.state.invoices['5006'] = { invoice_id: '5006', invoice_number: '019/ASM-HQ/XI/2026', custom: {}, comments: [], attachments: [] };
    db.updateDB(d => { d.users[0].zoho.fieldXml = ''; });
    await call('POST', `/zoho-to-coretax?api_key=${admin().apiKey}`, { body: { invoice: zohoInvoice({ invoice_id: '5006', invoice_number: '019/ASM-HQ/XI/2026', status: 'sent' }) } });
    await tick();
    const inv = mock.state.invoices['5006'];
    assert.deepStrictEqual(inv.attachments.map(a => a.name), ['efaktur-019_ASM-HQ_XI_2026.xml']);
    // simulasikan log lama tanpa xmlFileName
    const log = db.readDB().logs.filter(l => l.invoiceNumber === '019/ASM-HQ/XI/2026').at(-1);
    db.updateDB(d => { delete d.logs.find(l => l.id === log.id).xmlFileName; d.users[0].zoho.fieldXml = 'cf_hasil_xml'; });
    mock.state.attachmentResponseWithoutDocs = true;

    const rs = await call('POST', `/logs/${log.id}/resync`, { session: session() });
    assert.strictEqual(rs.body.success, true, rs.body.message);
    assert.strictEqual(inv.attachments.length, 1);
    assert.strictEqual(inv.custom.cf_hasil_xml, inv.attachments[0].document_id);
    mock.state.attachmentResponseWithoutDocs = false;
    mock.state.fields.find(x => x.api_name === 'cf_hasil_xml').data_type = 'multiline';
});

test('halaman Dashboard / Pending / Completed / Riwayat + unduh FP', async () => {
    const stages = require('../lib/stages');
    assert.strictEqual(stages.stageOf({ status: 'Success' }), 'pending');
    assert.strictEqual(stages.stageOf({ status: 'Success', faktur: { number: '1', hasPdf: true } }), 'completed');
    assert.strictEqual(stages.stageOf({ status: 'SMTP error' }), 'failed');
    assert.deepStrictEqual(stages.statusOf({ status: 'Success', faktur: { number: '1' } }).key, 'need_pdf');
    assert.deepStrictEqual(stages.statusOf({ status: 'Success', faktur: { number: '1', hasPdf: true }, zohoSync: { state: 'synced' } }).label, 'Synced');
    const g = stages.groupLogs([
        { id: 1, invoiceNumber: 'A', status: 'Success', faktur: { number: '1', hasPdf: true } },
        { id: 2, invoiceNumber: 'A', status: 'Success' },          // revisi terbaru -> pending
        { id: 3, invoiceNumber: 'B', status: 'SMTP error' }
    ]);
    assert.deepStrictEqual([g.pending.length, g.completed.length], [1, 0]);

    mock.state.invoices['5007'] = { invoice_id: '5007', invoice_number: 'INV-000107', custom: {}, comments: [], attachments: [] };
    await call('POST', `/zoho-to-coretax?api_key=${admin().apiKey}`, { body: { invoice: zohoInvoice({ invoice_id: '5007', invoice_number: 'INV-000107', status: 'sent' }) } });
    await tick();
    const log = db.readDB().logs.filter(l => l.invoiceNumber === 'INV-000107').at(-1);
    const has = (p, name) => p.data.rows.some(l => l.invoiceNumber === name);

    let pending = await call('GET', '/pending', { session: session() });
    assert.ok(has(pending, 'INV-000107'));
    const row = pending.data.rows.find(l => l.invoiceNumber === 'INV-000107');
    assert.strictEqual(row.xmlData, undefined);            // isi XML tidak dikirim ke template
    assert.strictEqual(row.statusInfo.label, 'Menunggu FP');
    assert.match(row.date, /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/);

    const dash = await call('GET', '/dashboard?range=7', { session: session() });
    assert.strictEqual(dash.data.range, 7);
    assert.strictEqual(dash.data.stats.buckets.length, 7);
    assert.ok(dash.data.stats.pending >= 1);
    assert.strictEqual((await call('GET', '/dashboard?range=999', { session: session() })).data.range, 30);
    assert.strictEqual((await call('GET', '/dashboard?range=90', { session: session() })).data.stats.buckets.length, 13);

    // Unduh FP belum ada
    assert.strictEqual((await call('GET', `/logs/${log.id}/faktur-pdf`, { session: session() })).status, 404);

    const pdf = 'data:application/pdf;base64,' + Buffer.from('%PDF-107').toString('base64');
    await call('POST', `/logs/${log.id}/faktur`, { session: session(), body: { fakturNumber: '04002600000000107', fakturDate: '2026-11-09', status: 'Approved', pdfBase64: pdf, pdfFilename: 'FP 107.pdf' } });

    pending = await call('GET', '/pending', { session: session() });
    assert.ok(!has(pending, 'INV-000107'));
    const completed = await call('GET', '/completed', { session: session() });
    const c = completed.data.rows.find(l => l.invoiceNumber === 'INV-000107');
    assert.ok(c && c.hasPdfFile);
    assert.strictEqual(c.statusInfo.label, 'Synced');
    assert.strictEqual(completed.data.counts.completed, completed.data.rows.length);

    const fp = await call('GET', `/logs/${log.id}/faktur-pdf`, { session: session() });
    assert.strictEqual(Buffer.from(fp.body).toString(), '%PDF-107');
    assert.strictEqual((await call('GET', `/logs/${log.id}/faktur-pdf`, { session: { ...session(), userId: 999 } })).status, 404);

    const hist = await call('GET', '/riwayat?range=all', { session: session() });
    assert.ok(hist.data.rows.some(l => l.invoiceNumber === 'INV-000107' && l.stage === 'completed'));
    assert.ok(hist.data.rows.length >= completed.data.rows.length);
    assert.strictEqual((await call('GET', '/riwayat?range=7', { session: session() })).data.range, 7);
});

test('revisi invoice: record baru bertanda Revisi N, XML lama tetap di Zoho, XML baru bernama -revN', async () => {
    db.updateDB(d => Object.assign(d.users[0].zoho, { fieldXml: '', attachXml: true }));
    mock.state.invoices['5008'] = { invoice_id: '5008', invoice_number: '021/ASM-HQ/XI/2026', custom: {}, comments: [], attachments: [] };
    const key = admin().apiKey;
    const base = { invoice_id: '5008', invoice_number: '021/ASM-HQ/XI/2026', status: 'sent' };
    const mails = sentMails.length;

    await call('POST', `/zoho-to-coretax?api_key=${key}`, { body: { invoice: zohoInvoice(base) } });
    await tick();
    // edit tanpa perubahan pajak -> dilewati
    const same = await call('POST', `/zoho-to-coretax?api_key=${key}`, { body: { invoice: zohoInvoice({ ...base, notes: 'ubah catatan' }) } });
    assert.strictEqual(same.body.skipped, true);
    // revisi nilai
    await call('POST', `/zoho-to-coretax?api_key=${key}`, { body: { invoice: zohoInvoice({ ...base, total: 555000, line_items: [{ name: 'Jasa', rate: 500000, quantity: 1, item_type: 'service' }] }) } });
    await tick();
    await call('POST', `/zoho-to-coretax?api_key=${key}`, { body: { invoice: zohoInvoice({ ...base, total: 666000, line_items: [{ name: 'Jasa', rate: 600000, quantity: 1, item_type: 'service' }] }) } });
    await tick();

    const logs = db.readDB().logs.filter(l => l.invoiceNumber === '021/ASM-HQ/XI/2026');
    assert.deepStrictEqual(logs.map(l => l.revision), [0, 1, 2]);
    assert.deepStrictEqual(mock.state.invoices['5008'].attachments.map(a => a.name), [
        'efaktur-021_ASM-HQ_XI_2026.xml', 'efaktur-021_ASM-HQ_XI_2026-rev1.xml', 'efaktur-021_ASM-HQ_XI_2026-rev2.xml'
    ]);
    const revMails = sentMails.slice(mails);
    assert.strictEqual(revMails.length, 3);
    assert.match(revMails[2].subject, /\(Revisi 2\)$/);
    assert.match(revMails[2].text, /DIREVISI/);
    assert.strictEqual(revMails[2].attachments[0].filename, 'efaktur-021_ASM-HQ_XI_2026-rev2.xml');
    assert.doesNotMatch(revMails[0].subject, /Revisi/);

    // Pending hanya menampilkan versi terbaru, bertanda revisi
    const pending = await call('GET', '/pending', { session: session() });
    const rows = pending.data.rows.filter(r => r.invoiceNumber === '021/ASM-HQ/XI/2026');
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].revision, 2);
    assert.ok(pending.data.counts.revised >= 1);

    // Riwayat menyimpan semua versi
    const hist = await call('GET', '/riwayat?range=all', { session: session() });
    assert.strictEqual(hist.data.rows.filter(r => r.invoiceNumber === '021/ASM-HQ/XI/2026').length, 3);
});
