// Klien Zoho Books API v3 (arah balik: gateway -> Zoho Books).
// Autentikasi memakai OAuth "Self Client" refresh token per tenant.
// Scope minimal: ZohoBooks.invoices.UPDATE,ZohoBooks.invoices.READ,ZohoBooks.invoices.CREATE,ZohoBooks.settings.READ
//   (atau cukup ZohoBooks.invoices.ALL,ZohoBooks.settings.READ)
const crypto = require('crypto');
const { decrypt } = require('./secret');
const config = require('./config');

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
// Cara update custom field yang terbukti berhasil per koneksi.
const updateMethodCache = new Map();

class ZohoBooksClient {
    constructor(zohoConfig, { fetchImpl } = {}) {
        const dc = DATA_CENTERS.includes(zohoConfig.dataCenter) ? zohoConfig.dataCenter : 'com';
        this.cfg = zohoConfig;
        this.organizationId = String(zohoConfig.organizationId || '').trim();
        // Mode "oauth" (tombol Hubungkan): client ID/secret milik aplikasi gateway dari .env.
        // Mode "self" (Self Client manual): client ID/secret milik tenant.
        const useApp = zohoConfig.authMode === 'oauth';
        this.clientId = useApp ? config.zohoOAuth.clientId : String(zohoConfig.clientId || '').trim();
        this.clientSecret = useApp ? config.zohoOAuth.clientSecret : decrypt(zohoConfig.clientSecret);
        this.refreshToken = decrypt(zohoConfig.refreshToken);
        this.accountsUrl = isAccountsHost(zohoConfig.accountsServer) ? zohoConfig.accountsServer : `https://accounts.zoho.${dc}`;
        this.apiUrl = (isApiDomain(zohoConfig.apiDomain) ? zohoConfig.apiDomain : `https://www.zohoapis.${dc}`) + '/books/v3';
        this.fetch = fetchImpl || globalThis.fetch;
        const tokenId = crypto.createHash('sha256').update(this.refreshToken || '').digest('hex').slice(0, 16);
        this.cacheKey = `${this.accountsUrl}:${this.clientId}:${tokenId}`;
    }

    assertConfigured({ requireOrg = true } = {}) {
        const missing = [];
        if (requireOrg && !this.organizationId) missing.push('Organization ID');
        if (!this.clientId) missing.push('Client ID');
        if (!this.clientSecret) missing.push('Client Secret');
        if (!this.refreshToken) missing.push('Refresh Token');
        if (missing.length) throw new ZohoError('Konfigurasi Zoho belum lengkap: ' + missing.join(', '));
    }

    async getAccessToken(force = false) {
        this.assertConfigured({ requireOrg: false });
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
    async request(method, path, { query = {}, json, form, noOrg = false } = {}) {
        if (!noOrg) this.assertConfigured();
        const url = new URL(this.apiUrl + path);
        if (!noOrg) url.searchParams.set('organization_id', this.organizationId);
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

    async listOrganizations() {
        const data = await this.request('GET', '/organizations', { noOrg: true });
        return (data.organizations || []).map(o => ({
            id: String(o.organization_id), name: o.name, isDefault: !!o.is_default_org
        }));
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

    // Tipe data custom field (mis. 'string', 'multiline', 'url', 'attachment'), atau '' jika tidak ditemukan.
    async getCustomFieldType(apiName) {
        const fields = await this.listInvoiceCustomFields();
        const f = fields.find(x => x.api_name === apiName || x.placeholder === apiName);
        return f ? String(f.data_type || '').toLowerCase() : '';
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
    // Hanya mengirim custom_fields: field invoice lain (line item, pajak, total) tidak tersentuh.
    // Beberapa cara dicoba karena format endpoint khusus custom field tidak terdokumentasi jelas;
    // cara yang berhasil diingat per koneksi.
    async updateInvoiceCustomFields(invoiceId, valuesByApiName) {
        const payload = await this.resolveCustomFields(valuesByApiName);
        if (!payload.length) return null;

        const strategies = {
            invoice: () => this.request('PUT', `/invoices/${invoiceId}`, { json: { custom_fields: payload } }),
            customfieldsForm: () => this.request('PUT', `/invoice/${invoiceId}/customfields`, {
                form: new URLSearchParams({ JSONString: JSON.stringify(payload) })
            })
        };
        const known = updateMethodCache.get(this.cacheKey);
        const order = known ? [known, ...Object.keys(strategies).filter(k => k !== known)] : Object.keys(strategies);

        let firstError;
        for (const name of order) {
            try {
                const res = await strategies[name]();
                updateMethodCache.set(this.cacheKey, name);
                return res;
            } catch (err) {
                // Error autentikasi / invoice tidak ada tidak akan berubah dengan cara lain
                if (err.status === 401 || err.status === 403 || err.code === 1002) throw err;
                firstError = firstError || err;
            }
        }
        throw firstError;
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

const clearCaches = () => { tokenCache.clear(); fieldCache.clear(); updateMethodCache.clear(); };

// ===================== OAuth "Hubungkan ke Zoho Books" =====================
// Aplikasi gateway didaftarkan SEKALI sebagai "Server-based Application" (Multi-DC aktif).
// Tenant cukup klik tombol, login ke Zoho, lalu Accept.

const OAUTH_SCOPES = 'ZohoBooks.invoices.ALL,ZohoBooks.settings.READ';

// Hanya domain resmi Zoho yang diterima (accounts-server datang dari query string callback).
const ACCOUNTS_HOST_RE = /^https:\/\/accounts\.(zoho\.(com|eu|in|com\.au|jp|sa|com\.cn|uk)|zohocloud\.ca)$/;
const API_DOMAIN_RE = /^https:\/\/www\.(zohoapis\.(com|eu|in|com\.au|jp|sa|com\.cn|ca|uk))$/;
const isAccountsHost = (v) => ACCOUNTS_HOST_RE.test(String(v || ''));
const isApiDomain = (v) => API_DOMAIN_RE.test(String(v || ''));

const dataCenterFromApiDomain = (apiDomain) => {
    const m = /zohoapis\.([a-z.]+)$/.exec(String(apiDomain || ''));
    return m && DATA_CENTERS.includes(m[1]) ? m[1] : 'com';
};

const oauthEnabled = () => !!(config.zohoOAuth.clientId && config.zohoOAuth.clientSecret);
const oauthRedirectUri = () => config.publicBaseUrl + '/zoho/oauth/callback';

const buildAuthorizeUrl = (state) => {
    const url = new URL('https://accounts.zoho.com/oauth/v2/auth');
    url.search = new URLSearchParams({
        scope: OAUTH_SCOPES,
        client_id: config.zohoOAuth.clientId,
        response_type: 'code',
        access_type: 'offline',  // supaya dapat refresh token
        prompt: 'consent',       // selalu tampilkan layar Accept agar refresh token selalu diberikan
        redirect_uri: oauthRedirectUri(),
        state
    }).toString();
    return url.toString();
};

// Tukar authorization code menjadi refresh token di data center milik user.
const exchangeCode = async ({ code, accountsServer }, { fetchImpl } = {}) => {
    const accounts = isAccountsHost(accountsServer) ? accountsServer : 'https://accounts.zoho.com';
    const res = await (fetchImpl || globalThis.fetch)(`${accounts}/oauth/v2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: config.zohoOAuth.clientId,
            client_secret: config.zohoOAuth.clientSecret,
            redirect_uri: oauthRedirectUri(),
            code
        }).toString()
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.refresh_token) {
        throw new ZohoError('Zoho menolak otorisasi: ' + (body.error || res.status) +
            (body.error === 'invalid_client' ? ' (cek ZOHO_CLIENT_ID/SECRET dan aktifkan Multi-DC di API Console)' : ''),
            { status: res.status, body });
    }
    const apiDomain = isApiDomain(body.api_domain) ? body.api_domain : 'https://www.zohoapis.com';
    return { refreshToken: body.refresh_token, accessToken: body.access_token, apiDomain, accountsServer: accounts };
};

const revokeRefreshToken = async (zohoConfig, { fetchImpl } = {}) => {
    const token = decrypt(zohoConfig.refreshToken);
    if (!token) return;
    const accounts = isAccountsHost(zohoConfig.accountsServer) ? zohoConfig.accountsServer : 'https://accounts.zoho.com';
    await (fetchImpl || globalThis.fetch)(`${accounts}/oauth/v2/token/revoke?token=${encodeURIComponent(token)}`, { method: 'POST' })
        .catch(() => {});
};

const isFileFieldType = (t) => /attach|file|document|upload|image/.test(String(t || ''));

module.exports = {
    isFileFieldType,
    ZohoBooksClient, ZohoError, DATA_CENTERS, clearCaches,
    oauthEnabled, oauthRedirectUri, buildAuthorizeUrl, exchangeCode, revokeRefreshToken,
    isAccountsHost, dataCenterFromApiDomain, OAUTH_SCOPES
};
