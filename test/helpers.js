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
            { field_id: '9003', api_name: 'cf_status_e_faktur', label: 'Status e-Faktur', data_type: 'string' },
            { field_id: '9004', api_name: 'cf_hasil_xml', label: 'Hasil XML', data_type: 'multiline' }
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
        if (u.pathname === '/oauth/v2/token/revoke') {
            state.revoked = (state.revoked || []).concat(u.searchParams.get('token'));
            return json(200, { status: 'success' });
        }
        if (u.pathname === '/oauth/v2/token') {
            state.tokenCalls++;
            state.tokenHosts = (state.tokenHosts || []).concat(u.origin);
            const p = new URLSearchParams(opts.body);
            if (p.get('grant_type') === 'authorization_code') {
                if (p.get('code') !== 'code-ok' || p.get('client_id') !== 'app-cid') return json(400, { error: 'invalid_code' });
                state.lastRedirectUri = p.get('redirect_uri');
                return json(200, { access_token: 'tok-auth', refresh_token: 'refresh-ok', api_domain: 'https://www.zohoapis.com', expires_in: 3600 });
            }
            if (p.get('refresh_token') !== 'refresh-ok') return json(400, { error: 'invalid_code' });
            return json(200, { access_token: 'tok-' + state.tokenCalls, expires_in: 3600 });
        }
        const auth = opts.headers && opts.headers.Authorization;
        state.calls.push({ method, path: u.pathname, query: Object.fromEntries(u.searchParams), auth, body: opts.body });
        if (state.expireNextToken) { state.expireNextToken = false; return json(401, { code: 57, message: 'Invalid token' }); }
        if (method === 'GET' && u.pathname === '/books/v3/organizations') {
            return json(200, { code: 0, organizations: [
                { organization_id: 'ORG0', name: 'PT Lain', is_default_org: false },
                { organization_id: 'ORG1', name: 'PT Contoh', is_default_org: true }
            ] });
        }
        if (u.searchParams.get('organization_id') !== 'ORG1') return json(400, { code: 6041, message: 'Invalid organization' });

        let m;
        if (method === 'GET' && u.pathname === '/books/v3/organizations/ORG1') return json(200, { code: 0, organization: { name: 'PT Contoh' } });
        if (method === 'GET' && u.pathname === '/books/v3/settings/fields') return json(200, { code: 0, fields: state.fields });
        if (method === 'GET' && (m = /^\/books\/v3\/invoices\/(\w+)$/.exec(u.pathname))) {
            const inv = state.invoices[m[1]];
            if (!inv) return json(404, { code: 1002, message: 'Invoice does not exist' });
            return json(200, { code: 0, invoice: { invoice_id: inv.invoice_id, invoice_number: inv.invoice_number,
                documents: inv.attachments.map(a => ({ document_id: a.document_id, file_name: a.name })) } });
        }
        if (method === 'GET' && u.pathname === '/books/v3/invoices') {
            const num = u.searchParams.get('invoice_number');
            return json(200, { code: 0, invoices: Object.values(state.invoices).filter(i => i.invoice_number === num) });
        }
        const applyCustom = (inv, incoming) => {
            if (incoming.some(f => String(f.value).length > (state.maxFieldLength || 100000))) {
                return json(400, { code: 4, message: 'Invalid value passed for custom field (too long)' });
            }
            for (const f of incoming) {
                const def = state.fields.find(x => x.field_id === f.customfield_id);
                if (def.data_type === 'attachment' && !inv.attachments.some(a => a.document_id === f.value)) {
                    return json(400, { code: 4, message: 'Invalid value passed for document ID.' });
                }
            }
            for (const f of incoming) {
                const def = state.fields.find(x => x.field_id === f.customfield_id);
                inv.custom[def.api_name] = f.value;
            }
            state.updateCalls = (state.updateCalls || []).concat(u.pathname);
            return json(200, { code: 0, message: 'Updated' });
        };
        if (method === 'PUT' && (m = /^\/books\/v3\/invoice\/(\w+)\/customfields$/.exec(u.pathname))) {
            const inv = state.invoices[m[1]];
            if (!inv) return json(404, { code: 1002, message: 'Invoice does not exist' });
            // Seperti Zoho asli: array JSON mentah ditolak
            if (typeof opts.body === 'string') return json(400, { code: 2, message: 'JSON is not well formed' });
            return applyCustom(inv, JSON.parse(opts.body.get('JSONString')));
        }
        if (method === 'PUT' && (m = /^\/books\/v3\/invoices\/(\w+)$/.exec(u.pathname))) {
            const inv = state.invoices[m[1]];
            if (!inv) return json(404, { code: 1002, message: 'Invoice does not exist' });
            if (state.rejectInvoicePut) return json(400, { code: 15, message: 'Please ensure that the customer is selected' });
            const body = JSON.parse(opts.body);
            if (Object.keys(body).some(k => k !== 'custom_fields')) return json(400, { code: 9, message: 'unexpected fields' });
            return applyCustom(inv, body.custom_fields);
        }
        if (method === 'POST' && (m = /^\/books\/v3\/invoices\/(\w+)\/comments$/.exec(u.pathname))) {
            state.invoices[m[1]].comments.push(JSON.parse(opts.body).description);
            return json(201, { code: 0, message: 'Comments added' });
        }
        if (method === 'POST' && (m = /^\/books\/v3\/invoices\/(\w+)\/attachment$/.exec(u.pathname))) {
            const file = opts.body.get('attachment');
            const document_id = 'DOC' + (++state.docSeq || (state.docSeq = 1));
            state.invoices[m[1]].attachments.push({ name: file.name, size: file.size, type: file.type, document_id });
            // Seperti Zoho asli, respons tidak selalu menyertakan documents
            return json(201, state.attachmentResponseWithoutDocs
                ? { code: 0, message: 'Your file has been successfully attached to the invoice.' }
                : { code: 0, message: 'Attachment added', documents: [{ document_id, file_name: file.name }] });
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

// Mock Airtable Web API: 1 base, 1 table "Invoices" dengan beberapa tipe field.
const createAirtableMock = () => {
    const state = {
        calls: [],
        fields: [
            { id: 'fldInv', name: 'No Invoice', type: 'singleLineText' },
            { id: 'fldNo', name: 'No Faktur Pajak', type: 'singleLineText' },
            { id: 'fldTgl', name: 'Tanggal FP', type: 'date' },
            { id: 'fldSt', name: 'Status FP', type: 'singleSelect' },
            { id: 'fldPdf', name: 'File FP', type: 'multipleAttachments' },
            { id: 'fldXml', name: 'File XML', type: 'multipleAttachments' },
            { id: 'fldAmt', name: 'Amount', type: 'currency' }
        ],
        records: [
            { id: 'rec1', fields: { fldInv: '021/ASM-HQ/XI/2026' } },
            { id: 'rec2', fields: { fldInv: 'INV-AT-1' } }
        ],
        seq: 10
    };
    const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, headers: { get: () => null } });
    const fetchImpl = async (url, opts = {}) => {
        const u = new URL(url);
        const method = opts.method || 'GET';
        state.calls.push({ method, host: u.host, path: u.pathname });
        if (opts.headers.Authorization !== 'Bearer pat-ok') return json(401, { error: { type: 'AUTHENTICATION_REQUIRED' } });
        const body = opts.body ? JSON.parse(opts.body) : null;
        let m;
        if (u.pathname === '/v0/meta/bases') return json(200, { bases: [{ id: 'appBASE', name: 'Finance', permissionLevel: 'create' }] });
        if ((m = /^\/v0\/meta\/bases\/(\w+)\/tables$/.exec(u.pathname))) {
            if (m[1] !== 'appBASE') return json(403, { error: { type: 'INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND' } });
            return json(200, { tables: [{ id: 'tblINV', name: 'Invoices', primaryFieldId: 'fldInv', fields: state.fields }] });
        }
        if (method === 'GET' && u.pathname === '/v0/appBASE/tblINV') {
            const f = u.searchParams.get('filterByFormula');
            const name = /\{(.+?)\}/.exec(f)[1];
            const val = /='(.*)'$/.exec(f)[1].replace(/\\'/g, "'");
            const fld = state.fields.find(x => x.name === name);
            const recs = state.records.filter(r => String(r.fields[fld.id] || '').trim().toLowerCase() === val);
            return json(200, { records: recs.slice(0, 2) });
        }
        if (method === 'POST' && u.pathname === '/v0/appBASE/tblINV') {
            const rec = { id: 'rec' + (++state.seq), fields: { ...body.records[0].fields } };
            state.records.push(rec);
            return json(200, { records: [rec] });
        }
        if (method === 'PATCH' && (m = /^\/v0\/appBASE\/tblINV\/(\w+)$/.exec(u.pathname))) {
            const rec = state.records.find(r => r.id === m[1]);
            if (!rec) return json(404, { error: { type: 'NOT_FOUND' } });
            Object.assign(rec.fields, body.fields);
            return json(200, rec);
        }
        if (u.host === 'content.airtable.com' && (m = /^\/v0\/appBASE\/(\w+)\/(\w+)\/uploadAttachment$/.exec(u.pathname))) {
            const rec = state.records.find(r => r.id === m[1]);
            rec.fields[m[2]] = (rec.fields[m[2]] || []).concat({ filename: body.filename, type: body.contentType, size: Buffer.from(body.file, 'base64').length });
            return json(200, rec);
        }
        return json(404, { error: { type: 'NOT_MOCKED', message: method + ' ' + url } });
    };
    return { state, fetchImpl };
};

module.exports.createAirtableMock = createAirtableMock;
