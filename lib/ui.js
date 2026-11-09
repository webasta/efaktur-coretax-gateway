// Helper tampilan (kelas Tailwind, format angka) yang dipakai semua template.
const BTN = 'inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition whitespace-nowrap';
module.exports = {
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
    th: 'px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500 whitespace-nowrap',
    td: 'px-4 py-3 align-top'
};
