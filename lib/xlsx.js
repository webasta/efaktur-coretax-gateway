// Pembaca .xlsx minimal tanpa dependensi (zip + XML sheet pertama).
// Cukup untuk membaca file ekspor daftar Faktur Keluaran dari Coretax.
const zlib = require('zlib');

const unzip = (buf) => {
    // Cari End Of Central Directory
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('File bukan XLSX/ZIP yang valid');
    const count = buf.readUInt16LE(eocd + 10);
    let ptr = buf.readUInt32LE(eocd + 16);
    const files = {};
    for (let n = 0; n < count; n++) {
        if (buf.readUInt32LE(ptr) !== 0x02014b50) throw new Error('Central directory ZIP rusak');
        const method = buf.readUInt16LE(ptr + 10);
        const compSize = buf.readUInt32LE(ptr + 20);
        const nameLen = buf.readUInt16LE(ptr + 28);
        const extraLen = buf.readUInt16LE(ptr + 30);
        const commentLen = buf.readUInt16LE(ptr + 32);
        const localOffset = buf.readUInt32LE(ptr + 42);
        const name = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen);
        ptr += 46 + nameLen + extraLen + commentLen;

        const lNameLen = buf.readUInt16LE(localOffset + 26);
        const lExtraLen = buf.readUInt16LE(localOffset + 28);
        const start = localOffset + 30 + lNameLen + lExtraLen;
        const raw = buf.subarray(start, start + compSize);
        files[name] = { method, raw };
    }
    return {
        names: Object.keys(files),
        read(name) {
            const f = files[name];
            if (!f) return null;
            const data = f.method === 8 ? zlib.inflateRawSync(f.raw) : f.raw;
            return data.toString('utf8');
        }
    };
};

const decodeXml = (s) => s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');

const textOf = (xml) => {
    // Gabungkan semua <t>...</t> (rich text bisa terpecah ke beberapa <r><t>)
    const parts = [];
    const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g;
    let m;
    while ((m = re.exec(xml))) parts.push(m[1] ? decodeXml(m[1]) : '');
    return parts.join('');
};

const colIndex = (ref) => {
    const letters = ref.replace(/[0-9]/g, '');
    let n = 0;
    for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
};

const firstSheetPath = (zip) => {
    const wb = zip.read('xl/workbook.xml');
    const rels = zip.read('xl/_rels/workbook.xml.rels');
    if (wb && rels) {
        const sheet = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(wb) || /<sheet\b[^>]*\bid="([^"]+)"/.exec(wb);
        if (sheet) {
            const relRe = new RegExp(`<Relationship\\b[^>]*Id="${sheet[1]}"[^>]*Target="([^"]+)"`);
            const relRe2 = new RegExp(`<Relationship\\b[^>]*Target="([^"]+)"[^>]*Id="${sheet[1]}"`);
            const rel = relRe.exec(rels) || relRe2.exec(rels);
            if (rel) {
                const target = rel[1].replace(/^\//, '');
                return target.startsWith('xl/') ? target : 'xl/' + target;
            }
        }
    }
    return zip.names.find(n => /^xl\/worksheets\/sheet\d*\.xml$/.test(n));
};

// Mengembalikan array baris; setiap baris = array nilai sel (string atau number).
const readXlsx = (buf) => {
    const zip = unzip(buf);
    const sstXml = zip.read('xl/sharedStrings.xml') || '';
    const shared = [];
    const siRe = /<si>([\s\S]*?)<\/si>/g;
    let m;
    while ((m = siRe.exec(sstXml))) shared.push(textOf(m[1]));

    const sheetPath = firstSheetPath(zip);
    const sheetXml = sheetPath && zip.read(sheetPath);
    if (!sheetXml) throw new Error('Sheet tidak ditemukan di file XLSX');

    const rows = [];
    const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
    while ((m = rowRe.exec(sheetXml))) {
        const row = [];
        const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
        let c;
        let autoIdx = 0;
        while ((c = cellRe.exec(m[1]))) {
            const attrs = c[1];
            const inner = c[2] || '';
            const ref = /\br="([A-Z]+\d+)"/.exec(attrs);
            const idx = ref ? colIndex(ref[1]) : autoIdx;
            autoIdx = idx + 1;
            const type = (/\bt="([^"]+)"/.exec(attrs) || [])[1];
            const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
            let value = '';
            if (type === 's') value = v ? (shared[parseInt(v[1], 10)] ?? '') : '';
            else if (type === 'inlineStr') value = textOf(inner);
            else if (type === 'str' || type === 'e') value = v ? decodeXml(v[1]) : '';
            else if (type === 'b') value = v ? v[1] === '1' : '';
            else value = v ? Number(v[1]) : '';
            row[idx] = value;
        }
        for (let i = 0; i < row.length; i++) if (row[i] === undefined) row[i] = '';
        rows.push(row);
    }
    return rows;
};

module.exports = { readXlsx };
