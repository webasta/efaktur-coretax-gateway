// Helper tampilan (kelas Tailwind, format angka) yang dipakai semua template.
const BTN = 'inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition whitespace-nowrap';
const REV_TIP = 'Invoice direvisi di Zoho Books. Jika XML versi sebelumnya sudah diunggah ke Coretax, hapus draft lama di Coretax sebelum mengunggah XML ini.';
const REGEN_TIP = 'XML dibuat ulang dari gateway (perbaikan format/data). Jika XML lama sudah diunggah ke Coretax, hapus draft lamanya dulu.';

module.exports = {
    // Label versi XML: "Revisi N" (invoice diubah di Zoho) atau "XML vN" (dibuat ulang dari gateway)
    revLabel: (l) => (l.revisionReason === 'regenerate' ? `XML v${l.revision + 1}` : `Revisi ${l.revision}`),
    revTip: (l) => (l.revisionReason === 'regenerate' ? REGEN_TIP : REV_TIP),
    rp: (n) => 'Rp ' + Number(n || 0).toLocaleString('id-ID'),
    btnPrimary: BTN + ' bg-indigo-600 text-white hover:bg-indigo-700 shadow-sm',
    btnGhost: BTN + ' bg-white text-slate-700 ring-1 ring-inset ring-slate-200 hover:bg-slate-50',
    btnDisabled: BTN + ' bg-slate-50 text-slate-300 ring-1 ring-inset ring-slate-100 cursor-not-allowed',
    chip: 'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset whitespace-nowrap',
    statusClass: {
        synced: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
        not_synced: 'bg-slate-50 text-slate-600 ring-slate-500/20',
        sync_failed: 'bg-red-50 text-red-700 ring-red-600/20',
        failed: 'bg-red-50 text-red-700 ring-red-600/20',
        need_pdf: 'bg-amber-50 text-amber-700 ring-amber-600/20',
        waiting_fp: 'bg-sky-50 text-sky-700 ring-sky-600/20',
        pending: 'bg-amber-50 text-amber-700 ring-amber-600/20',
        completed: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20'
    },
    revChip: 'inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide bg-violet-50 text-violet-700 ring-1 ring-inset ring-violet-600/20 whitespace-nowrap',
    th: 'px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500 whitespace-nowrap',
    td: 'px-4 py-3 align-top'
};
