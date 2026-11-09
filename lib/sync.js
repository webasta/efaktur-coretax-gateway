// Alur balik: hasil Coretax (NSFP, tanggal, status) -> custom field + komentar + lampiran di Zoho Books.
const db = require('./db');
const { ZohoBooksClient, isFileFieldType } = require('./zoho');

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
        let fieldXml = cfg.fieldXml;
        const errors = [];
        const base = `efaktur-${String(log.invoiceNumber).replace(/[^\w.-]+/g, '_')}`;
        const xmlBuf = Buffer.from(log.xmlData, 'utf8');

        if (fieldXml) {
            const type = await client.getCustomFieldType(fieldXml).catch(() => '');
            if (isFileFieldType(type)) {
                // Field bertipe Attachment: isi dengan document_id file XML yang diunggah ke invoice.
                fieldXml = '';
                try {
                    let docId = log.xmlDocumentId || '';
                    if (!docId && log.xmlAttached) {
                        // Lampiran lama (nama file mungkin belum tercatat): cari berdasarkan nama default
                        for (const name of [log.xmlFileName, `${base}.xml`, `${base}.xml.txt`].filter(Boolean)) {
                            docId = await client.findInvoiceDocumentId(invoiceId, name);
                            if (docId) break;
                        }
                    }
                    if (!docId) {
                        const name = `${base}.xml`;
                        docId = await client.attachAndGetDocumentId(invoiceId, name, xmlBuf, 'application/xml');
                        patchLog(logId, { xmlAttached: true, xmlFileName: name });
                        log = { ...log, xmlAttached: true };
                        done.push('lampiran XML');
                    }
                    if (!docId) throw new Error('document_id file XML tidak ditemukan di respons Zoho');
                    patchLog(logId, { xmlDocumentId: docId });
                    try {
                        await client.updateInvoiceCustomFields(invoiceId, { [cfg.fieldXml]: docId });
                    } catch (err) {
                        // Format alternatif nilai field Attachment
                        await client.updateInvoiceCustomFields(invoiceId, { [cfg.fieldXml]: [{ document_id: docId }] });
                    }
                    done.push(`${cfg.fieldXml} (file XML)`);
                } catch (err) {
                    errors.push(`${cfg.fieldXml} (field Attachment): ${err.message}`);
                }
            }
        }
        const link = fieldXml ? xmlLink(ensureXmlToken(logId)) : '';
        if (fieldXml) fields[fieldXml] = cfg.xmlFieldMode === 'content' ? log.xmlData : link;

        if (Object.keys(fields).length) {
            try {
                try {
                    await client.updateInvoiceCustomFields(invoiceId, fields);
                } catch (err) {
                    // Isi XML terlalu panjang / tipe field tidak cocok -> coba lagi dengan link
                    if (fieldXml && cfg.xmlFieldMode === 'content' && !/tidak ditemukan/.test(err.message)) {
                        fields[fieldXml] = link;
                        await client.updateInvoiceCustomFields(invoiceId, fields);
                        notes.push('isi XML ditolak Zoho, diganti link');
                    } else throw err;
                }
                if (fields[cfg.fieldFakturStatus]) done.push('status "XML Dibuat"');
                if (fieldXml) done.push(`${fieldXml} (${fields[fieldXml] === link ? 'link' : 'isi XML'})`);
            } catch (err) {
                errors.push('custom field: ' + err.message);
            }
        }

        if (cfg.attachXml && log.xmlAttached && !done.includes('lampiran XML')) notes.push('lampiran XML sudah ada');
        if (cfg.attachXml && !log.xmlAttached) {
            try {
                await client.addInvoiceAttachment(invoiceId, `${base}.xml`, xmlBuf, 'application/xml');
                patchLog(logId, { xmlAttached: true, xmlFileName: `${base}.xml` });
                done.push('lampiran XML');
            } catch (err) {
                // Jika Zoho menolak tipe .xml, lampirkan sebagai .txt (isi tetap XML)
                try {
                    await client.addInvoiceAttachment(invoiceId, `${base}.xml.txt`, xmlBuf, 'text/plain');
                    patchLog(logId, { xmlAttached: true, xmlFileName: `${base}.xml.txt` });
                    done.push('lampiran XML (.xml.txt)');
                } catch (err2) {
                    errors.push('lampiran XML: ' + err.message);
                }
            }
        }

        if (errors.length) {
            const message = (done.length ? 'Terkirim: ' + done.join(', ') + ' | ' : '') + 'Gagal: ' + errors.join('; ');
            patchLog(logId, { zohoSync: { state: 'failed', at: nowLabel(), message } });
            return { ok: false, message, error: message };
        }

        const message = (done.length ? 'Terkirim ke Zoho: ' + done.join(', ') : 'Tidak ada yang perlu dikirim') +
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

// ---- Penyimpanan PDF faktur di folder data, agar bisa dikirim ulang saat Sinkron ----
const fs = require('fs');
const path = require('path');
const filesDir = () => {
    const dir = path.join(config.dataDir, 'files');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
};
const savePdf = (logId, buffer) => {
    const name = `${logId}-faktur.pdf`;
    fs.writeFileSync(path.join(filesDir(), name), buffer);
    return name;
};
const loadPdf = (name) => {
    if (!name || !/^[\w.-]+$/.test(name)) return null;
    const file = path.join(filesDir(), name);
    return fs.existsSync(file) ? fs.readFileSync(file) : null;
};

/**
 * Simpan hasil Coretax ke log lalu kirim ke Zoho Books.
 * result: { fakturNumber, fakturDate, status, source, pdf: { filename, buffer } }
 * Setiap langkah (custom field, komentar, lampiran PDF) berdiri sendiri: satu gagal tidak menghentikan yang lain.
 */
const pushFakturToZoho = async (userId, logId, result) => {
    const newPdf = result.pdf && result.pdf.buffer && result.pdf.buffer.length ? result.pdf : null;
    let log = patchLog(logId, (l) => {
        const prev = l.faktur || {};
        const next = {
            ...prev,
            number: String(result.fakturNumber || '').trim(),
            date: result.fakturDate || '',
            status: result.status || '',
            source: result.source || 'manual',
            updatedAt: nowLabel()
        };
        if (newPdf) {
            next.pdfFile = savePdf(l.id, newPdf.buffer);
            next.pdfName = newPdf.filename || `FakturPajak-${next.number || l.invoiceNumber}.pdf`;
            next.hasPdf = true;
            next.pdfAttached = false; // PDF baru -> perlu dilampirkan
        }
        return { faktur: next };
    });
    if (!log) throw new Error('Log tidak ditemukan');
    const faktur = log.faktur;

    const user = getUser(userId);
    if (!zohoReady(user)) {
        patchLog(logId, { zohoSync: { state: 'pending', at: nowLabel(), message: 'Integrasi Zoho belum diaktifkan di Pengaturan' } });
        return { ok: false, pending: true, message: 'Tersimpan di gateway. Integrasi Zoho belum aktif.' };
    }

    const cfg = user.zoho;
    const client = clientFactory(cfg);
    const done = [];
    const errors = [];
    let invoiceId;
    try {
        invoiceId = await ensureInvoiceId(client, log);
    } catch (err) {
        patchLog(logId, { zohoSync: { state: 'failed', at: nowLabel(), message: err.message } });
        return { ok: false, message: err.message };
    }

    // 1. Custom field
    const fields = {};
    if (cfg.fieldFakturNumber && faktur.number) fields[cfg.fieldFakturNumber] = faktur.number;
    if (cfg.fieldFakturDate && isIsoDate(faktur.date)) fields[cfg.fieldFakturDate] = faktur.date;
    if (cfg.fieldFakturStatus) fields[cfg.fieldFakturStatus] = faktur.status || (faktur.number ? 'Approved' : '');
    Object.keys(fields).forEach(k => fields[k] === '' && delete fields[k]);
    if (Object.keys(fields).length) {
        try { await client.updateInvoiceCustomFields(invoiceId, fields); done.push('custom field'); }
        catch (err) { errors.push('custom field: ' + err.message); }
    }

    // 2. Komentar — hanya jika data faktur berubah sejak komentar terakhir
    const commentKey = `${faktur.number}|${faktur.date}|${faktur.status}`;
    if (cfg.addComment && faktur.commentKey !== commentKey) {
        try {
            const parts = [`Faktur Pajak Coretax: ${faktur.number || '-'}`];
            if (faktur.date) parts.push(`tanggal ${faktur.date}`);
            if (faktur.status) parts.push(`status ${faktur.status}`);
            await client.addInvoiceComment(invoiceId, parts.join(', ') + ` (disinkronkan oleh e-Faktur Gateway, sumber: ${faktur.source}).`);
            patchLog(logId, l => ({ faktur: { ...l.faktur, commentKey } }));
            done.push('komentar');
        } catch (err) { errors.push('komentar: ' + err.message); }
    }

    // 3. Lampiran PDF — sekali per file PDF
    if (cfg.attachPdf && faktur.pdfFile && !faktur.pdfAttached) {
        const buffer = loadPdf(faktur.pdfFile);
        if (!buffer) errors.push('lampiran PDF: file tidak ditemukan di gateway, unggah ulang');
        else {
            try {
                await client.addInvoiceAttachment(invoiceId, faktur.pdfName || `FakturPajak-${faktur.number}.pdf`, buffer, 'application/pdf');
                patchLog(logId, l => ({ faktur: { ...l.faktur, pdfAttached: true } }));
                done.push('lampiran PDF');
            } catch (err) { errors.push('lampiran PDF: ' + err.message); }
        }
    }

    const ok = errors.length === 0;
    const message = (done.length ? 'Terkirim ke Zoho: ' + done.join(', ') : 'Tidak ada perubahan untuk dikirim') +
        (errors.length ? ' | Gagal: ' + errors.join('; ') : '');
    patchLog(logId, { zohoSync: { state: ok ? 'synced' : 'failed', at: nowLabel(), message } });
    return { ok, message, invoiceId };
};

// Sinkron ulang lengkap: XML (lampiran + field) lalu data faktur jika ada.
const resyncLog = async (userId, logId) => {
    const log = db.readDB().logs.find(l => l.id === logId);
    if (!log) return { ok: false, message: 'Log tidak ditemukan' };
    const parts = [];
    let ok = true;
    if (log.xmlData) {
        const x = await pushXmlToZoho(userId, logId);
        if (x.skipped) return { ok: false, pending: true, message: x.error };
        parts.push('XML: ' + x.message);
        ok = ok && x.ok;
    }
    if (log.faktur && log.faktur.number) {
        const f = await pushFakturToZoho(userId, logId, {
            fakturNumber: log.faktur.number, fakturDate: log.faktur.date, status: log.faktur.status, source: 'sinkron ulang'
        });
        parts.push('Faktur: ' + f.message);
        ok = ok && f.ok;
    }
    if (!parts.length) return { ok: false, message: 'Belum ada XML maupun data faktur untuk dikirim' };
    return { ok, message: parts.join(' • ') };
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

module.exports = { pushFakturToZoho, pushXmlToZoho, resyncLog, markXmlGenerated, xmlLink, matchRecords, applyRecords, setClientFactory };
