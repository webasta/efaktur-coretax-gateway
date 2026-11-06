// Klien Zoho Books API v3 (arah balik: gateway -> Zoho Books).
// Autentikasi memakai OAuth "Self Client" refresh token per tenant.
// Scope minimal: ZohoBooks.invoices.UPDATE,ZohoBooks.invoices.READ,ZohoBooks.invoices.CREATE,ZohoBooks.settings.READ
//   (atau cukup ZohoBooks.invoices.ALL,ZohoBooks.settings.READ)
const { decrypt } = require('./secret');

const DATA_CENTERS = ['com', 'eu', 'in', 'com.au', 'jp', 'ca', 'sa', 'com.cn'];

class ZohoError extends Error {
    constructor(message, { status, code, body } = {}) {
        super(message);
        this.name = 'ZohoError';
        this.status = status;
        this.code = code;
        this.body = body;
    }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Cache access token di memori per tenant (access token Zoho berlaku 1 jam,
// dan Zoho membatasi frekuensi refresh, jadi jangan refresh setiap request).
const tokenCache = new Map();
// Cache pemetaan api_name -> customfield_id per organisasi.
const fieldCache = new Map();

class ZohoBooksClient {
    constructor(zohoConfig, { fetchImpl } = {}) {
        const dc = DATA_CENTERS.includes(zohoConfig.dataCenter) ? zohoConfig.dataCenter : 'com';
        this.cfg = zohoConfig;
        this.organizationId = String(zohoConfig.organizationId || '').trim();
        this.clientId = String(zohoConfig.clientId || '').trim();
        this.clientSecret = decrypt(zohoConfig.clientSecret);
        this.refreshToken = decrypt(zohoConfig.refreshToken);
        this.accountsUrl = `https://accounts.zoho.${dc}`;
        this.apiUrl = `https://www.zohoapis.${dc}/books/v3`;
        this.fetch = fetchImpl || globalThis.fetch;
        this.cacheKey = `${dc}:${this.clientId}:${this.organizationId}`;
    }

    assertConfigured() {
        const missing = [];
        if (!this.organizationId) missing.push('Organization ID');
        if (!this.clientId) missing.push('Client ID');
        if (!this.clientSecret) missing.push('Client Secret');
        if (!this.refreshToken) missing.push('Refresh Token');
        if (missing.length) throw new ZohoError('Konfigurasi Zoho belum lengkap: ' + missing.join(', '));
    }

    async getAccessToken(force = false) {
        this.assertConfigured();
        const cached = tokenCache.get(this.cacheKey);
        if (!force && cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

        const params = new URLSearchParams({
            refresh_token: this.refreshToken,
            client_id: this.clientId,
            client_secret: this.clientSecret,
            grant_type: 'refresh_token'
        });
        const res = await this.fetch(`${this.accountsUrl}/oauth/v2/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params.toString()
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || !body.access_token) {
            throw new ZohoError('Gagal mendapatkan access token Zoho: ' + (body.error || res.status), { status: res.status, body });
        }
        tokenCache.set(this.cacheKey, {
            token: body.access_token,
            expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000
        });
        return body.access_token;
    }

    // Request generik dengan retry untuk 401 (token kedaluwarsa) dan 429/5xx (rate limit / gangguan).
    async request(method, path, { query = {}, json, form } = {}) {
        const url = new URL(this.apiUrl + path);
        url.searchParams.set('organization_id', this.organizationId);
        Object.entries(query).forEach(([k, v]) => v !== undefined && url.searchParams.set(k, v));

        let refreshed = false;
        for (let attempt = 0; attempt < 4; attempt++) {
            const token = await this.getAccessToken();
            const headers = { Authorization: `Zoho-oauthtoken ${token}` };
            let body;
            if (json !== undefined) {
                headers['Content-Type'] = 'application/json';
                body = JSON.stringify(json);
            } else if (form) {
                body = form; // FormData: Content-Type diatur otomatis oleh fetch
            }

            const res = await this.fetch(url.toString(), { method, headers, body });
            const data = await res.json().catch(() => ({}));

            if (res.status === 401 && !refreshed) {
                refreshed = true;
                tokenCache.delete(this.cacheKey);
                continue;
            }
            // 5xx hanya di-retry untuk request idempoten (GET/PUT) agar komentar/lampiran tidak dobel.
            const retryable = res.status === 429 || (res.status >= 500 && (method === 'GET' || method === 'PUT'));
            if (retryable && attempt < 3) {
                const retryAfter = Number(res.headers && res.headers.get && res.headers.get('retry-after'));
                await sleep(retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt);
                continue;
            }
            if (!res.ok || (data.code !== undefined && data.code !== 0)) {
                throw new ZohoError(`Zoho API ${method} ${path} gagal: ${data.message || res.status}`, {
                    status: res.status, code: data.code, body: data
                });
            }
            return data;
        }
        throw new ZohoError(`Zoho API ${method} ${path} gagal setelah beberapa percobaan`);
    }

    // --- Operasi tingkat tinggi ---

    async testConnection() {
        const data = await this.request('GET', `/organizations/${this.organizationId}`);
        return data.organization || {};
    }

    async getInvoice(invoiceId) {
        const data = await this.request('GET', `/invoices/${invoiceId}`);
        return data.invoice;
    }

    // Cari invoice berdasarkan nomor (dipakai untuk log lama yang belum menyimpan invoice_id).
    async findInvoiceByNumber(invoiceNumber) {
        const data = await this.request('GET', '/invoices', { query: { invoice_number: invoiceNumber } });
        const list = data.invoices || [];
        const exact = list.find(i => String(i.invoice_number).toLowerCase() === String(invoiceNumber).toLowerCase());
        return exact || null;
    }

    async listInvoiceCustomFields(force = false) {
        const key = this.cacheKey;
        const cached = fieldCache.get(key);
        if (!force && cached && cached.at > Date.now() - 10 * 60_000) return cached.fields;
        const data = await this.request('GET', '/settings/fields', { query: { entity: 'invoice' } });
        const fields = data.fields || data.customfields || [];
        fieldCache.set(key, { at: Date.now(), fields });
        return fields;
    }

    // Ubah { cf_xxx: nilai } menjadi [{ customfield_id, value }].
    async resolveCustomFields(valuesByApiName) {
        const wanted = Object.entries(valuesByApiName).filter(([name]) => name);
        if (!wanted.length) return [];
        let fields = await this.listInvoiceCustomFields();
        const find = (list, name) => list.find(f =>
            f.api_name === name || f.placeholder === name ||
            (f.label && f.label.toLowerCase() === name.toLowerCase()));

        const missing = wanted.filter(([name]) => !find(fields, name));
        if (missing.length) fields = await this.listInvoiceCustomFields(true);

        const result = [];
        const notFound = [];
        for (const [name, value] of wanted) {
            const f = find(fields, name);
            if (!f) { notFound.push(name); continue; }
            result.push({ customfield_id: String(f.field_id || f.customfield_id), value });
        }
        if (notFound.length) {
            throw new ZohoError(`Custom field invoice tidak ditemukan di Zoho Books: ${notFound.join(', ')}. ` +
                'Buat dulu di Settings > Preferences > Invoices > Field Customization, lalu cocokkan API name-nya di Pengaturan gateway.');
        }
        return result;
    }

    // Update custom field tanpa menyentuh isi invoice lainnya (line item, pajak, dll).
    async updateInvoiceCustomFields(invoiceId, valuesByApiName) {
        const payload = await this.resolveCustomFields(valuesByApiName);
        if (!payload.length) return null;
        return this.request('PUT', `/invoice/${invoiceId}/customfields`, { json: payload });
    }

    async addInvoiceComment(invoiceId, description) {
        return this.request('POST', `/invoices/${invoiceId}/comments`, {
            json: { description, show_comment_to_clients: false }
        });
    }

    async addInvoiceAttachment(invoiceId, filename, buffer, mimeType = 'application/pdf') {
        const form = new FormData();
        form.append('attachment', new Blob([buffer], { type: mimeType }), filename);
        return this.request('POST', `/invoices/${invoiceId}/attachment`, {
            query: { can_send_in_email: 'false' },
            form
        });
    }
}

const clearCaches = () => { tokenCache.clear(); fieldCache.clear(); };

module.exports = { ZohoBooksClient, ZohoError, DATA_CENTERS, clearCaches };
