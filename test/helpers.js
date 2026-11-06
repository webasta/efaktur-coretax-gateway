// Utilitas pengujian: database sementara, mock Zoho Books API, dan stub modul npm
// (supaya test bisa jalan tanpa `npm install`, mis. di CI tanpa internet).
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const tmpDataDir = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'efaktur-test-'));
    process.env.DATA_DIR = dir;
    process.env.APP_SECRET = 'test-secret';
    return dir;
};

// Stub xmlbuilder2 minimal (dipakai hanya jika paket asli belum terpasang).
const xmlbuilderStub = () => {
    const escape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const node = (name, attrs) => ({
        name, attrs: attrs || {}, children: [], text: null,
        ele(n, a) { const c = node(n, a); this.children.push(c); return c; },
        txt(t) { this.text = t; return this; },
        render(indent = '') {
            const a = Object.entries(this.attrs).map(([k, v]) => ` ${k}="${v}"`).join('');
            if (this.text !== null) return `${indent}<${this.name}${a}>${escape(this.text)}</${this.name}>`;
            return `${indent}<${this.name}${a}>\n${this.children.map(c => c.render(indent + '  ')).join('\n')}\n${indent}</${this.name}>`;
        }
    });
    return {
        create: () => {
            let root;
            return {
                ele(n, a) { root = node(n, a); root.end = () => '<?xml version="1.0"?>\n' + root.render(); return root; }
            };
        }
    };
};

// Ganti modul yang belum terpasang dengan stub. `force` = selalu stub walau terpasang.
const installStubs = (stubs, force = []) => {
    const originalLoad = Module._load;
    Module._load = function (request, parent, isMain) {
        if (stubs[request]) {
            let installed = true;
            try { require.resolve(request); } catch (_) { installed = false; }
            if (!installed || force.includes(request)) return stubs[request]();
        }
        return originalLoad.apply(this, arguments);
    };
};

// Mock Zoho Books: menyimpan invoice, custom field, komentar, lampiran di memori.
const createZohoMock = () => {
    const state = {
        tokenCalls: 0,
        calls: [],
        expireNextToken: false,
        fields: [
            { field_id: '9001', api_name: 'cf_nomor_faktur_pajak', label: 'Nomor Faktur Pajak', data_type: 'string' },
            { field_id: '9002', api_name: 'cf_tanggal_faktur_pajak', label: 'Tanggal Faktur Pajak', data_type: 'date' },
            { field_id: '9003', api_name: 'cf_status_e_faktur', label: 'Status e-Faktur', data_type: 'string' }
        ],
        invoices: {
            '5001': { invoice_id: '5001', invoice_number: 'INV-000101', custom: {}, comments: [], attachments: [] },
            '5002': { invoice_id: '5002', invoice_number: 'INV-000102', custom: {}, comments: [], attachments: [] },
            '5099': { invoice_id: '5099', invoice_number: 'INV-LAMA-01', custom: {}, comments: [], attachments: [] }
        }
    };
    const json = (status, body, headers = {}) => ({
        ok: status >= 200 && status < 300, status,
        json: async () => body,
        headers: { get: (k) => headers[k.toLowerCase()] }
    });

    const fetchImpl = async (url, opts = {}) => {
        const u = new URL(url);
        const method = opts.method || 'GET';
        if (u.pathname === '/oauth/v2/token') {
            state.tokenCalls++;
            const p = new URLSearchParams(opts.body);
            if (p.get('refresh_token') !== 'refresh-ok') return json(400, { error: 'invalid_code' });
            return json(200, { access_token: 'tok-' + state.tokenCalls, expires_in: 3600 });
        }
        const auth = opts.headers && opts.headers.Authorization;
        state.calls.push({ method, path: u.pathname, query: Object.fromEntries(u.searchParams), auth, body: opts.body });
        if (state.expireNextToken) { state.expireNextToken = false; return json(401, { code: 57, message: 'Invalid token' }); }
        if (u.searchParams.get('organization_id') !== 'ORG1') return json(400, { code: 6041, message: 'Invalid organization' });

        let m;
        if (method === 'GET' && u.pathname === '/books/v3/organizations/ORG1') return json(200, { code: 0, organization: { name: 'PT Contoh' } });
        if (method === 'GET' && u.pathname === '/books/v3/settings/fields') return json(200, { code: 0, fields: state.fields });
        if (method === 'GET' && u.pathname === '/books/v3/invoices') {
            const num = u.searchParams.get('invoice_number');
            return json(200, { code: 0, invoices: Object.values(state.invoices).filter(i => i.invoice_number === num) });
        }
        if (method === 'PUT' && (m = /^\/books\/v3\/invoice\/(\w+)\/customfields$/.exec(u.pathname))) {
            const inv = state.invoices[m[1]];
            if (!inv) return json(404, { code: 1002, message: 'Invoice does not exist' });
            for (const f of JSON.parse(opts.body)) {
                const def = state.fields.find(x => x.field_id === f.customfield_id);
                inv.custom[def.api_name] = f.value;
            }
            return json(200, { code: 0, message: 'Custom fields updated' });
        }
        if (method === 'POST' && (m = /^\/books\/v3\/invoices\/(\w+)\/comments$/.exec(u.pathname))) {
            state.invoices[m[1]].comments.push(JSON.parse(opts.body).description);
            return json(201, { code: 0, message: 'Comments added' });
        }
        if (method === 'POST' && (m = /^\/books\/v3\/invoices\/(\w+)\/attachment$/.exec(u.pathname))) {
            const file = opts.body.get('attachment');
            state.invoices[m[1]].attachments.push({ name: file.name, size: file.size, type: file.type });
            return json(201, { code: 0, message: 'Attachment added' });
        }
        return json(404, { code: 404, message: 'Not mocked: ' + method + ' ' + u.pathname });
    };
    return { state, fetchImpl };
};

const zohoConfig = (overrides = {}) => ({
    enabled: true, dataCenter: 'com', organizationId: 'ORG1', clientId: 'cid',
    clientSecret: 'csecret', refreshToken: 'refresh-ok',
    fieldFakturNumber: 'cf_nomor_faktur_pajak', fieldFakturDate: 'cf_tanggal_faktur_pajak', fieldFakturStatus: 'cf_status_e_faktur',
    markOnXmlGenerated: true, addComment: true, attachPdf: true,
    ...overrides
});

module.exports = { tmpDataDir, installStubs, xmlbuilderStub, createZohoMock, zohoConfig };
