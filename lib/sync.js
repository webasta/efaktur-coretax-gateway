// Alur balik: hasil Coretax (NSFP, tanggal, status) -> custom field + komentar + lampiran di Zoho Books.
const db = require('./db');
const { ZohoBooksClient } = require('./zoho');

const nowLabel = () => new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
const isIsoDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

let clientFactory = (zohoCfg) => new ZohoBooksClient(zohoCfg);
const setClientFactory = (fn) => { clientFactory = fn; }; // untuk pengujian

const getUser = (userId) => db.readDB().users.find(u => u.id === userId);

const patchLog = (logId, patch) => db.updateDB(d => {
    const log = d.logs.find(l => l.id === logId);
    if (log) Object.assign(log, typeof patch === 'function' ? patch(log) : patch);
    return log;
});

const zohoReady = (user) => user && user.zoho && user.zoho.enabled;

// Pastikan log punya zohoInvoiceId; log lama (v1.0.0) belum menyimpannya.
const ensureInvoiceId = async (client, log) => {
    if (log.zohoInvoiceId) return log.zohoInvoiceId;
    const inv = await client.findInvoiceByNumber(log.invoiceNumber);
    if (!inv) throw new Error(`Invoice ${log.invoiceNumber} tidak ditemukan di Zoho Books`);
    patchLog(log.id, { zohoInvoiceId: inv.invoice_id });
    return inv.invoice_id;
};

const crypto = require('crypto');
const config = require('./config');

// Link unduhan XML tanpa login (token acak 128-bit per log). Dipakai untuk mengisi custom field di Zoho.
const ensureXmlToken = (logId) => patchLog(logId, (l) => ({ xmlToken: l.xmlToken || crypto.randomBytes(16).toString('hex') })).xmlToken;
const xmlLink = (token) => `${config.publicBaseUrl}/xml/${token}`;

/**
 * Kirim hasil XML ke Zoho (dipanggil otomatis setelah webhook sukses, atau via tombol Sinkron).
 * - custom field status  -> "XML Dibuat"
 * - custom field hasil XML -> link unduhan (default) atau isi XML (fallback ke link jika ditolak Zoho)
 * - lampiran file .xml pada invoice (sekali per XML)
 */
const pushXmlToZoho = async (userId, logId) => {
    const user = getUser(userId);
    if (!zohoReady(user)) return { skipped: true, error: 'Integrasi Zoho belum aktif' };
    const cfg = user.zoho;
    let log = db.readDB().logs.find(l => l.id === logId);
    if (!log || !log.xmlData) return { skipped: true, error: 'Log tidak punya XML' };

    const client = clientFactory(cfg);
    const done = [];
    const notes = [];
    try {
        const invoiceId = await ensureInvoiceId(client, log);

        const fields = {};
        if (cfg.markOnXmlGenerated && cfg.fieldFakturStatus && !(log.faktur && log.faktur.number)) fields[cfg.fieldFakturStatus] = 'XML Dibuat';
        const link = cfg.fieldXml ? xmlLink(ensureXmlToken(logId)) : '';
        if (cfg.fieldXml) fields[cfg.fieldXml] = cfg.xmlFieldMode === 'content' ? log.xmlData : link;

        if (Object.keys(fields).length) {
            try {
                await client.updateInvoiceCustomFields(invoiceId, fields);
            } catch (err) {
                // Isi XML terlalu panjang / tipe field tidak cocok -> coba lagi dengan link
                if (cfg.fieldXml && cfg.xmlFieldMode === 'content' && !/tidak ditemukan/.test(err.message)) {
                    fields[cfg.fieldXml] = link;
                    await client.updateInvoiceCustomFields(invoiceId, fields);
                    notes.push('isi XML ditolak Zoho, diganti link');
                } else throw err;
            }
            if (fields[cfg.fieldFakturStatus]) done.push('status "XML Dibuat"');
            if (cfg.fieldXml) done.push(`${cfg.fieldXml} (${fields[cfg.fieldXml] === link ? 'link' : 'isi XML'})`);
        }

        if (cfg.attachXml && !log.xmlAttached) {
            try {
                await client.addInvoiceAttachment(invoiceId, `efaktur-${log.invoiceNumber}.xml`, Buffer.from(log.xmlData, 'utf8'), 'application/xml');
                patchLog(logId, { xmlAttached: true });
                done.push('lampiran XML');
            } catch (err) {
                notes.push('lampiran XML gagal: ' + err.message);
            }
        }

        const message = (done.length ? 'Terkirim ke Zoho: ' + done.join(', ') : 'Tidak ada yang dikirim (cek pengaturan field)') +
            (notes.length ? ' — ' + notes.join('; ') : '');
        // Jangan timpa status "synced" milik nomor faktur
        if (!(log.zohoSync && log.zohoSync.state === 'synced')) {
            patchLog(logId, { zohoSync: { state: 'xml_marked', at: nowLabel(), message } });
        }
        return { ok: true, message };
    } catch (err) {
        patchLog(logId, { zohoSync: { state: 'failed', at: nowLabel(), message: err.message } });
        return { ok: false, error: err.message, message: err.message };
    }
};
const markXmlGenerated = pushXmlToZoho; // nama lama, tetap didukung

/**
 * Simpan hasil Coretax ke log lalu kirim ke Zoho Books.
 * result: { fakturNumber, fakturDate, status, source, pdf: { filename, buffer } }
 */
const pushFakturToZoho = async (userId, logId, result) => {
    const faktur = {
        number: String(result.fakturNumber || '').trim(),
        date: result.fakturDate || '',
        status: result.status || '',
        source: result.source || 'manual',
        updatedAt: nowLabel(),
        hasPdf: !!(result.pdf && result.pdf.buffer)
    };
    let log = patchLog(logId, (l) => ({ faktur: { ...(l.faktur || {}), ...faktur, hasPdf: faktur.hasPdf || !!(l.faktur && l.faktur.hasPdf) } }));
    if (!log) throw new Error('Log tidak ditemukan');

    const user = getUser(userId);
    if (!zohoReady(user)) {
        patchLog(logId, { zohoSync: { state: 'pending', at: nowLabel(), message: 'Integrasi Zoho belum diaktifkan di Pengaturan' } });
        return { ok: false, pending: true, message: 'Tersimpan di gateway. Integrasi Zoho belum aktif.' };
    }

    const cfg = user.zoho;
    const client = clientFactory(cfg);
    try {
        const invoiceId = await ensureInvoiceId(client, log);

        const fields = {};
        if (cfg.fieldFakturNumber && faktur.number) fields[cfg.fieldFakturNumber] = faktur.number;
        if (cfg.fieldFakturDate && isIsoDate(faktur.date)) fields[cfg.fieldFakturDate] = faktur.date;
        if (cfg.fieldFakturStatus) fields[cfg.fieldFakturStatus] = faktur.status || (faktur.number ? 'Approved' : '');
        Object.keys(fields).forEach(k => fields[k] === '' && delete fields[k]);
        if (Object.keys(fields).length) await client.updateInvoiceCustomFields(invoiceId, fields);

        const done = ['custom field'];
        if (cfg.addComment) {
            const parts = [`Faktur Pajak Coretax: ${faktur.number || '-'}`];
            if (faktur.date) parts.push(`tanggal ${faktur.date}`);
            if (faktur.status) parts.push(`status ${faktur.status}`);
            await client.addInvoiceComment(invoiceId, parts.join(', ') + ` (disinkronkan oleh e-Faktur Gateway, sumber: ${faktur.source}).`);
            done.push('komentar');
        }
        if (cfg.attachPdf && result.pdf && result.pdf.buffer) {
            const name = result.pdf.filename || `FakturPajak-${faktur.number || log.invoiceNumber}.pdf`;
            await client.addInvoiceAttachment(invoiceId, name, result.pdf.buffer);
            done.push('lampiran PDF');
        }

        const message = 'Terkirim ke Zoho: ' + done.join(', ');
        patchLog(logId, { zohoSync: { state: 'synced', at: nowLabel(), message } });
        return { ok: true, message, invoiceId };
    } catch (err) {
        patchLog(logId, { zohoSync: { state: 'failed', at: nowLabel(), message: err.message } });
        return { ok: false, message: err.message };
    }
};

// Cocokkan baris hasil ekspor Coretax dengan log gateway (berdasarkan Referensi = nomor invoice Zoho).
const matchRecords = (userId, records) => {
    const logs = db.readDB().logs.filter(l => l.userId === userId && l.status === 'Success');
    return records.map(rec => {
        const ref = rec.reference.toLowerCase();
        const candidates = logs.filter(l => String(l.invoiceNumber || '').toLowerCase() === ref);
        const log = candidates.sort((a, b) => b.id - a.id)[0];
        let action = 'sync';
        let note = rec.warning || '';
        if (!rec.reference) { action = 'skip'; note = 'Kolom Referensi kosong'; }
        else if (!rec.fakturNumber) { action = 'skip'; note = 'Nomor faktur kosong'; }
        else if (!log) { action = 'lookup'; note = 'Tidak ada di log gateway, invoice akan dicari langsung di Zoho'; }
        else if (log.faktur && log.faktur.number === rec.fakturNumber && (log.faktur.status || '') === rec.status &&
                 log.zohoSync && log.zohoSync.state === 'synced') {
            action = 'unchanged'; note = 'Sudah tersinkron dengan data yang sama';
        }
        return { ...rec, logId: log ? log.id : null, action, note };
    });
};

// Jalankan sinkronisasi untuk hasil matchRecords. Diproses berurutan agar tidak memicu rate limit Zoho.
const applyRecords = async (userId, matched, { force = false } = {}) => {
    const results = [];
    for (const rec of matched) {
        if (rec.action === 'skip' || (rec.action === 'unchanged' && !force)) {
            results.push({ ...rec, ok: rec.action === 'unchanged', message: rec.note });
            continue;
        }
        let logId = rec.logId;
        if (!logId) {
            // Buat entri log untuk invoice yang dibuat di luar gateway, agar riwayatnya tercatat.
            logId = Date.now() + Math.floor(Math.random() * 1000);
            db.updateDB(d => d.logs.push({
                id: logId, userId, timestamp: nowLabel(), invoiceNumber: rec.reference,
                customerName: '-', totalAmount: 0, totalVat: Number(rec.vat) || 0,
                status: 'Success', source: 'coretax-import'
            }));
        }
        const r = await pushFakturToZoho(userId, logId, {
            fakturNumber: rec.fakturNumber, fakturDate: rec.fakturDate, status: rec.status, source: 'impor Coretax'
        });
        results.push({ ...rec, logId, ok: r.ok, message: r.message });
    }
    return results;
};

module.exports = { pushFakturToZoho, pushXmlToZoho, markXmlGenerated, xmlLink, matchRecords, applyRecords, setClientFactory };
