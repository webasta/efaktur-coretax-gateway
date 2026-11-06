// Membaca file ekspor daftar Faktur Pajak Keluaran dari Coretax (CSV / XLSX)
// dan menormalkannya menjadi { reference, fakturNumber, fakturDate, status, buyerTin, vat }.
//
// Nama kolom ekspor Coretax tidak dibakukan DJP, jadi header dicocokkan dengan daftar alias.
// Baris header dicari otomatis di 15 baris pertama (file ekspor kadang punya baris judul).
const { readXlsx } = require('./xlsx');

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

const ALIASES = {
    reference: ['referensi', 'reference', 'refdesc', 'nomorreferensi', 'noreferensi', 'reffaktur', 'nomorinvoice', 'noinvoice', 'invoicenumber'],
    fakturNumber: ['nomorfakturpajak', 'nofakturpajak', 'nomorfaktur', 'nofaktur', 'nsfp', 'taxinvoicenumber', 'nomorserifakturpajak', 'kodedannomorserifakturpajak'],
    fakturDate: ['tanggalfakturpajak', 'tglfakturpajak', 'tanggalfaktur', 'tglfaktur', 'taxinvoicedate', 'tanggal'],
    status: ['statusfaktur', 'statusfakturpajak', 'taxinvoicestatus', 'status', 'statusapproval'],
    buyerTin: ['npwppembeli', 'npwpnikpembeli', 'npwppembeliidentitaslainnya', 'buyertin', 'npwp'],
    vat: ['ppn', 'vat', 'jumlahppn', 'totalppn']
};

// --- CSV ---
const detectDelimiter = (line) => {
    const counts = { ',': 0, ';': 0, '\t': 0 };
    let q = false;
    for (const ch of line) {
        if (ch === '"') q = !q;
        else if (!q && counts[ch] !== undefined) counts[ch]++;
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
};

const parseCsv = (text) => {
    text = text.replace(/^﻿/, '');
    const delim = detectDelimiter(text.split(/\r?\n/, 1)[0] || '');
    const rows = [];
    let row = [], field = '', q = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (q) {
            if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
            else if (ch === '"') q = false;
            else field += ch;
        } else if (ch === '"') q = true;
        else if (ch === delim) { row.push(field); field = ''; }
        else if (ch === '\n' || ch === '\r') {
            if (ch === '\r' && text[i + 1] === '\n') i++;
            row.push(field); rows.push(row); row = []; field = '';
        } else field += ch;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
};

// --- Normalisasi nilai ---
const excelSerialToDate = (n) => {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(n * 86400000));
    return d.toISOString().slice(0, 10);
};

const normalizeDate = (v) => {
    if (v === '' || v === null || v === undefined) return '';
    if (typeof v === 'number') return v > 20000 && v < 80000 ? excelSerialToDate(v) : '';
    const s = String(v).trim();
    let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
    if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/.exec(s); // format Indonesia: dd/mm/yyyy
    if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    const bulan = { jan: 1, feb: 2, mar: 3, apr: 4, mei: 5, may: 5, jun: 6, jul: 7, agu: 8, aug: 8, ags: 8, sep: 9, okt: 10, oct: 10, nov: 11, des: 12, dec: 12 };
    m = /^(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\s+(\d{4})/.exec(s);
    if (m && bulan[m[2].toLowerCase()]) return `${m[3]}-${String(bulan[m[2].toLowerCase()]).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    return s;
};

const normalizeFakturNumber = (v) => {
    if (typeof v === 'number') {
        // Nomor 17 digit yang tersimpan sebagai angka di Excel kehilangan presisi.
        return { value: String(v), warning: 'Nomor faktur tersimpan sebagai angka di Excel (presisi bisa hilang). Format kolom sebagai Text.' };
    }
    const digits = String(v || '').replace(/[^0-9]/g, '');
    return { value: digits || String(v || '').trim(), warning: digits && digits.length !== 17 ? `Nomor faktur ${digits.length} digit (umumnya 17 digit)` : '' };
};

const findHeader = (rows) => {
    for (let r = 0; r < Math.min(rows.length, 15); r++) {
        const cells = rows[r].map(norm);
        const map = {};
        for (const [key, aliases] of Object.entries(ALIASES)) {
            // Prioritaskan alias yang lebih spesifik (urutan di daftar)
            for (const alias of aliases) {
                const idx = cells.indexOf(alias);
                if (idx !== -1 && !Object.values(map).includes(idx)) { map[key] = idx; break; }
            }
        }
        if (map.fakturNumber !== undefined && map.reference !== undefined) return { headerRow: r, map };
    }
    return null;
};

const parseCoretaxExport = (buffer, filename = '') => {
    const isXlsx = /\.xlsx$/i.test(filename) || (buffer[0] === 0x50 && buffer[1] === 0x4b);
    const rows = isXlsx ? readXlsx(buffer) : parseCsv(buffer.toString('utf8'));
    const header = findHeader(rows);
    if (!header) {
        throw new Error('Kolom wajib tidak ditemukan. File harus punya kolom "Nomor Faktur Pajak" dan "Referensi" ' +
            '(Referensi = nomor invoice Zoho yang dikirim gateway sebagai RefDesc).');
    }
    const { headerRow, map } = header;
    const get = (row, key) => (map[key] === undefined ? '' : row[map[key]]);

    const records = [];
    for (let r = headerRow + 1; r < rows.length; r++) {
        const row = rows[r];
        if (!row || row.every(c => c === '' || c === null || c === undefined)) continue;
        const faktur = normalizeFakturNumber(get(row, 'fakturNumber'));
        const reference = String(get(row, 'reference') ?? '').trim();
        if (!reference && !faktur.value) continue;
        records.push({
            row: r + 1,
            reference,
            fakturNumber: faktur.value,
            fakturDate: normalizeDate(get(row, 'fakturDate')),
            status: String(get(row, 'status') ?? '').trim(),
            buyerTin: String(get(row, 'buyerTin') ?? '').replace(/[^0-9]/g, ''),
            vat: get(row, 'vat'),
            warning: faktur.warning
        });
    }
    return {
        columns: Object.fromEntries(Object.entries(map).map(([k, i]) => [k, rows[headerRow][i]])),
        records
    };
};

module.exports = { parseCoretaxExport, parseCsv, normalizeDate, normalizeFakturNumber };
