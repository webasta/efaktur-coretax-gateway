// Klien Airtable Web API untuk menyalin hasil Faktur Pajak ke record Airtable milik tenant.
// Autentikasi: Personal Access Token (airtable.com/create/tokens) dengan scope
//   data.records:read, data.records:write, schema.bases:read
// dan akses ke base yang dipakai.
const { decrypt } = require('./secret');

const API = 'https://api.airtable.com/v0';
const CONTENT_API = 'https://content.airtable.com/v0';
const MAX_UPLOAD = 5 * 1024 * 1024; // batas endpoint uploadAttachment

// Tipe field yang cocok untuk tiap pemetaan (dipakai UI dan validasi).
const FIELD_TYPES = {
    match: ['singleLineText', 'multilineText', 'richText', 'formula', 'singleSelect', 'email', 'url', 'number', 'autoNumber'],
    fakturNumber: ['singleLineText', 'multilineText', 'richText'],
    fakturDate: ['date', 'dateTime', 'singleLineText'],
    fakturStatus: ['singleLineText', 'singleSelect', 'multilineText'],
    pdf: ['multipleAttachments'],
    xml: ['multipleAttachments']
};
const MAPPING_KEYS = Object.keys(FIELD_TYPES);

class AirtableError extends Error {
    constructor(message, { status, body } = {}) {
        super(message);
        this.name = 'AirtableError';
        this.status = status;
        this.body = body;
    }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const schemaCache = new Map(); // `${tokenTail}:${baseId}` -> { at, tables }

class AirtableClient {
    constructor(tokenOrConfig, { fetchImpl } = {}) {
        const raw = typeof tokenOrConfig === 'string' ? tokenOrConfig : (tokenOrConfig && tokenOrConfig.token);
        this.token = decrypt(raw || '').trim();
        this.fetch = fetchImpl || globalThis.fetch;
    }

    async request(method, url, json) {
        if (!this.token) throw new AirtableError('Personal Access Token Airtable belum diisi');
        for (let attempt = 0; attempt < 4; attempt++) {
            const res = await this.fetch(url, {
                method,
                headers: { Authorization: `Bearer ${this.token}`, ...(json ? { 'Content-Type': 'application/json' } : {}) },
                body: json ? JSON.stringify(json) : undefined
            });
            const body = await res.json().catch(() => ({}));
            if (res.status === 429 && attempt < 3) { await sleep(1000 * (attempt + 1)); continue; }
            if (!res.ok) {
                const e = body.error || {};
                const type = typeof e === 'string' ? e : e.type;
                let msg = (typeof e === 'object' && e.message) || type || `HTTP ${res.status}`;
                if (res.status === 401) msg = 'Token Airtable tidak valid atau sudah dicabut';
                if (res.status === 403 || type === 'INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND') {
                    msg = 'Token tidak punya akses ke base/table ini (cek scope & daftar base pada token)';
                }
                throw new AirtableError(`Airtable: ${msg}`, { status: res.status, body });
            }
            return body;
        }
        throw new AirtableError('Airtable: terlalu banyak permintaan, coba lagi nanti');
    }

    async listBases() {
        const bases = [];
        let offset;
        do {
            const url = `${API}/meta/bases` + (offset ? `?offset=${encodeURIComponent(offset)}` : '');
            const data = await this.request('GET', url);
            bases.push(...(data.bases || []).map(b => ({ id: b.id, name: b.name, permissionLevel: b.permissionLevel })));
            offset = data.offset;
        } while (offset);
        return bases;
    }

    async getTables(baseId, force = false) {
        const key = `${this.token.slice(-8)}:${baseId}`;
        const cached = schemaCache.get(key);
        if (!force && cached && cached.at > Date.now() - 10 * 60_000) return cached.tables;
        const data = await this.request('GET', `${API}/meta/bases/${encodeURIComponent(baseId)}/tables`);
        const tables = (data.tables || []).map(t => ({
            id: t.id, name: t.name, primaryFieldId: t.primaryFieldId,
            fields: (t.fields || []).map(f => ({ id: f.id, name: f.name, type: f.type }))
        }));
        schemaCache.set(key, { at: Date.now(), tables });
        return tables;
    }

    async getTable(baseId, tableId, force = false) {
        let table = (await this.getTables(baseId, force)).find(t => t.id === tableId);
        if (!table && !force) table = (await this.getTables(baseId, true)).find(t => t.id === tableId);
        if (!table) throw new AirtableError('Airtable: table yang dipilih tidak ditemukan (mungkin dihapus/diganti)');
        return table;
    }

    // Cari record berdasarkan nilai field pencocok (dibandingkan sebagai teks, tanpa beda huruf besar/kecil & spasi tepi).
    async findRecord(baseId, tableId, fieldName, value) {
        const v = String(value).trim().toLowerCase().replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        const name = String(fieldName).replace(/}/g, '\\}');
        const formula = `LOWER(TRIM({${name}}&''))='${v}'`;
        const url = `${API}/${encodeURIComponent(baseId)}/${encodeURIComponent(tableId)}?maxRecords=2&filterByFormula=${encodeURIComponent(formula)}`;
        const data = await this.request('GET', url);
        const records = data.records || [];
        return { record: records[0] || null, duplicates: records.length > 1 };
    }

    async createRecord(baseId, tableId, fields) {
        const data = await this.request('POST', `${API}/${encodeURIComponent(baseId)}/${encodeURIComponent(tableId)}`, {
            records: [{ fields }], typecast: true
        });
        return data.records[0];
    }

    async updateRecord(baseId, tableId, recordId, fields) {
        return this.request('PATCH', `${API}/${encodeURIComponent(baseId)}/${encodeURIComponent(tableId)}/${recordId}`, {
            fields, typecast: true
        });
    }

    async uploadAttachment(baseId, recordId, fieldId, filename, contentType, buffer) {
        if (buffer.length > MAX_UPLOAD) throw new AirtableError('Airtable: file lebih dari 5 MB tidak bisa diunggah lewat API');
        const path = `/${encodeURIComponent(baseId)}/${recordId}/${encodeURIComponent(fieldId)}/uploadAttachment`;
        const body = { contentType, file: buffer.toString('base64'), filename };
        try {
            return await this.request('POST', CONTENT_API + path, body);
        } catch (err) {
            if (err.status === 404) return this.request('POST', API + path, body);
            throw err;
        }
    }
}

const clearSchemaCache = () => schemaCache.clear();

module.exports = { AirtableClient, AirtableError, FIELD_TYPES, MAPPING_KEYS, clearSchemaCache };
