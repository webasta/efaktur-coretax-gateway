// Pengelompokan invoice untuk dashboard:
//   baru     -> XML sudah dibuat, belum diproses di Coretax
//   upload   -> sudah diproses di Coretax, nomor faktur / PDF belum lengkap
//   lengkap  -> nomor faktur + PDF sudah ada
// Hanya log sukses terbaru per nomor invoice yang dihitung (revisi menggantikan versi lama).

const stageOf = (log) => {
    const f = log.faktur || {};
    if (f.number && (f.hasPdf || f.pdfAttached)) return 'lengkap';
    if (f.number || log.coretaxUploadedAt || log.xmlDownloadedAt) return 'upload';
    return 'baru';
};

// Apa yang masih kurang, untuk ditampilkan sebagai petunjuk di kartu "Perlu Upload Faktur".
const missingOf = (log) => {
    const f = log.faktur || {};
    const missing = [];
    if (!f.number) missing.push('Nomor faktur');
    if (!(f.hasPdf || f.pdfAttached)) missing.push('PDF faktur');
    return missing;
};

const groupLogs = (logs) => {
    const latest = new Map();
    for (const log of logs) {
        if (log.status !== 'Success') continue;
        const key = String(log.invoiceNumber || '').toLowerCase();
        const cur = latest.get(key);
        if (!cur || log.id > cur.id) latest.set(key, log);
    }
    const sections = { baru: [], upload: [], lengkap: [] };
    for (const log of [...latest.values()].sort((a, b) => b.id - a.id)) {
        sections[stageOf(log)].push({ ...log, stage: stageOf(log), missing: missingOf(log) });
    }
    return sections;
};

module.exports = { stageOf, missingOf, groupLogs };
