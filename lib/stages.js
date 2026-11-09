// Pengelompokan invoice untuk tampilan:
//   pending   -> XML sudah terbit, Faktur Pajak (nomor + PDF) belum lengkap
//   completed -> nomor faktur + PDF sudah ada
// Hanya log sukses terbaru per nomor invoice yang dihitung (revisi menggantikan versi lama).
// Waktu dibuat diambil dari id log (Date.now() saat log dibuat).

const TZ_OFFSET_MS = 7 * 3600 * 1000; // Asia/Jakarta (WIB, tanpa DST)

const isComplete = (log) => {
    const f = log.faktur || {};
    return !!(f.number && (f.hasPdf || f.pdfAttached));
};

const stageOf = (log) => {
    if (log.status !== 'Success') return 'failed';
    return isComplete(log) ? 'completed' : 'pending';
};

// Status singkat untuk kolom "Status" di tabel Pending / Completed.
const statusOf = (log) => {
    const f = log.faktur || {};
    const z = log.zohoSync || {};
    if (log.status !== 'Success') return { key: 'failed', label: 'Gagal' };
    if (isComplete(log)) {
        if (z.state === 'synced') return { key: 'synced', label: 'Synced' };
        if (z.state === 'failed') return { key: 'sync_failed', label: 'Sync gagal' };
        return { key: 'not_synced', label: 'Belum sync' };
    }
    if (z.state === 'failed') return { key: 'sync_failed', label: 'Sync gagal' };
    if (f.number) return { key: 'need_pdf', label: 'PDF FP belum' };
    return { key: 'waiting_fp', label: 'Menunggu FP' };
};

const latestPerInvoice = (logs) => {
    const latest = new Map();
    for (const log of logs) {
        if (log.status !== 'Success') continue;
        const key = String(log.invoiceNumber || '').toLowerCase();
        const cur = latest.get(key);
        if (!cur || log.id > cur.id) latest.set(key, log);
    }
    return [...latest.values()].sort((a, b) => b.id - a.id);
};

const groupLogs = (logs) => {
    const sections = { pending: [], completed: [] };
    for (const log of latestPerInvoice(logs)) sections[isComplete(log) ? 'completed' : 'pending'].push(log);
    return sections;
};

const dayKey = (ms) => new Date(ms + TZ_OFFSET_MS).toISOString().slice(0, 10);

// Statistik dashboard untuk periode N hari terakhir (7 / 30 / 90).
const buildStats = (logs, rangeDays, now = Date.now()) => {
    const start = now - rangeDays * 86400000;
    const inRange = latestPerInvoice(logs).filter(l => l.id >= start);
    const failed = logs.filter(l => l.status !== 'Success' && l.id >= start);

    // 90 hari -> per minggu, selain itu per hari
    const weekly = rangeDays > 31;
    const bucketMs = (weekly ? 7 : 1) * 86400000;
    const count = Math.ceil(rangeDays / (weekly ? 7 : 1));
    const todayStart = Date.parse(dayKey(now) + 'T00:00:00Z') - TZ_OFFSET_MS; // 00:00 WIB hari ini
    // Bucket terakhir berakhir hari ini (untuk mingguan: 6 hari lalu s/d hari ini)
    const lastStart = todayStart - (bucketMs - 86400000);
    const firstStart = lastStart - (count - 1) * bucketMs;
    const fmt = (ms) => {
        const d = new Date(ms + TZ_OFFSET_MS);
        return `${d.getUTCDate()}/${d.getUTCMonth() + 1}`;
    };
    const buckets = Array.from({ length: count }, (_, i) => {
        const from = firstStart + i * bucketMs;
        return { from, label: weekly ? `${fmt(from)}–${fmt(from + bucketMs - 86400000)}` : fmt(from), pending: 0, completed: 0 };
    });
    for (const l of inRange) {
        const idx = Math.floor((l.id - firstStart) / bucketMs);
        if (idx >= 0 && idx < count) buckets[idx][isComplete(l) ? 'completed' : 'pending']++;
    }

    const completed = inRange.filter(isComplete);
    return {
        rangeDays,
        weekly,
        total: inRange.length,
        pending: inRange.length - completed.length,
        completed: completed.length,
        failed: failed.length,
        totalPpn: inRange.reduce((s, l) => s + (Number(l.totalVat) || 0), 0),
        totalAmount: inRange.reduce((s, l) => s + (Number(l.totalAmount) || 0), 0),
        completionRate: inRange.length ? Math.round(completed.length / inRange.length * 100) : 0,
        buckets,
        maxBucket: Math.max(1, ...buckets.map(b => b.pending + b.completed))
    };
};

const formatDate = (ms) => {
    const d = new Date(ms + TZ_OFFSET_MS);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
};

module.exports = { isComplete, stageOf, statusOf, groupLogs, latestPerInvoice, buildStats, formatDate, dayKey };
