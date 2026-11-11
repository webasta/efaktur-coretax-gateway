const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const h = require('./helpers');

h.tmpDataDir();
h.installStubs({ xmlbuilder2: h.xmlbuilderStub });

const { buildXml, buildLineItems, getCustomField, invoiceFingerprint } = require('../lib/efaktur');
const { parseCoretaxExport, normalizeDate } = require('../lib/coretaxImport');
const { ZohoBooksClient, clearCaches } = require('../lib/zoho');
const { encrypt, decrypt } = require('../lib/secret');

const fixture = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n));

test('enkripsi AES-GCM bolak-balik dan kompatibel dengan nilai lama (plain)', () => {
    const enc = encrypt('rahasia');
    assert.ok(enc.startsWith('enc:v1:'));
    assert.notStrictEqual(enc, encrypt('rahasia')); // IV acak
    assert.strictEqual(decrypt(enc), 'rahasia');
    assert.strictEqual(decrypt('password-lama'), 'password-lama');
    assert.strictEqual(encrypt(enc), enc); // tidak dienkripsi dua kali
});

test('XML kode 04: DPP Nilai Lain 11/12 dan VATRate 12', () => {
    const inv = {
        invoice_number: 'INV-1', date: '2026-11-03', customer_name: 'PT A & B', cf_npwp: '00.123.456.7-890.100',
        line_items: [
            { name: 'Jasa Konsultasi', rate: 1200000, quantity: 1, item_type: 'service', tax_percentage: 11 },
            { name: 'Barang', rate: 50000, quantity: 3, discount: 0 },
            { name: 'Gratis', rate: 0, quantity: 1 }
        ]
    };
    const { items, totalVat } = buildLineItems(inv);
    assert.strictEqual(items.length, 2);
    assert.strictEqual(items[0].OtherTaxBase, 1100000);
    assert.strictEqual(items[0].VATRate, 12);
    assert.strictEqual(items[0].VAT, 132000); // = 11% x 1.200.000
    assert.strictEqual(totalVat, 132000 + 16500);

    const { xml } = buildXml(inv, { sellerTin: '0800195299077000', sellerTku: '0800195299077000000000' });
    assert.match(xml, /<RefDesc>INV-1<\/RefDesc>/);
    assert.match(xml, /<BuyerTin>0001234567890100<\/BuyerTin>/);      // 15 digit -> '0' di depan
    assert.match(xml, /<BuyerIDTKU>0001234567890100000000<\/BuyerIDTKU>/); // 22 digit
    assert.match(xml, /<BuyerCountry>IDN<\/BuyerCountry>/);
    // Urutan elemen TaxInvoice sesuai template DJP
    const order = [...xml.matchAll(/<(\w+)[\s>/]/g)].map(m => m[1]);
    const ti = order.slice(order.indexOf('TaxInvoiceDate'), order.indexOf('ListOfGoodService'));
    assert.deepStrictEqual(ti.filter((x, i) => ti.indexOf(x) === i), [
        'TaxInvoiceDate', 'TaxInvoiceOpt', 'TrxCode', 'AddInfo', 'CustomDoc', 'CustomDocMonthYear', 'RefDesc',
        'FacilityStamp', 'SellerIDTKU', 'BuyerTin', 'BuyerDocument', 'BuyerCountry', 'BuyerDocumentNumber',
        'BuyerName', 'BuyerAdress', 'BuyerEmail', 'BuyerIDTKU'
    ]);
    assert.match(xml, /<VATRate>12<\/VATRate>/);
    assert.match(xml, /PT A &amp; B/);
});

test('getCustomField membaca cf dari top-level, custom_field_hash, dan array custom_fields', () => {
    assert.strictEqual(getCustomField({ cf_npwp: '1' }, 'cf_npwp'), '1');
    assert.strictEqual(getCustomField({ custom_field_hash: { cf_npwp: '2' } }, 'cf_npwp'), '2');
    assert.strictEqual(getCustomField({ custom_fields: [{ api_name: 'cf_npwp', value: '3' }] }, 'cf_npwp'), '3');
    assert.strictEqual(getCustomField({}, 'cf_npwp'), '');
});

test('fingerprint stabil, berubah jika isi invoice berubah', () => {
    const a = { date: '2026-11-01', total: 100, line_items: [{ name: 'x', rate: 100, quantity: 1 }] };
    const b = { ...a, cf_status_e_faktur: 'XML Dibuat' }; // update dari gateway tidak mengubah fingerprint
    assert.strictEqual(invoiceFingerprint(a), invoiceFingerprint(b));
    assert.notStrictEqual(invoiceFingerprint(a), invoiceFingerprint({ ...a, total: 200 }));
});

test('normalizeDate berbagai format', () => {
    assert.strictEqual(normalizeDate('2026-11-03'), '2026-11-03');
    assert.strictEqual(normalizeDate('03/11/2026'), '2026-11-03');
    assert.strictEqual(normalizeDate('5 Nov 2026'), '2026-11-05');
    assert.strictEqual(normalizeDate('05 Agustus 2026'), '2026-08-05');
    assert.strictEqual(normalizeDate(46329), '2026-11-03'); // serial Excel
});

test('parse ekspor Coretax XLSX (baris judul, tanggal Excel, baris kosong)', () => {
    const r = parseCoretaxExport(fixture('coretax-export-sample.xlsx'), 'export.xlsx');
    assert.strictEqual(r.columns.fakturNumber, 'Nomor Faktur Pajak');
    assert.strictEqual(r.columns.reference, 'Referensi');
    assert.strictEqual(r.records.length, 4);
    assert.deepStrictEqual(
        { ref: r.records[0].reference, no: r.records[0].fakturNumber, tgl: r.records[0].fakturDate, st: r.records[0].status },
        { ref: 'INV-000101', no: '04002600000000101', tgl: '2026-11-03', st: 'APPROVED' }
    );
    assert.strictEqual(r.records[1].fakturDate, '2026-11-05');
    assert.strictEqual(r.records[3].reference, '');
});

test('parse ekspor Coretax CSV (delimiter ;, kutip)', () => {
    const r = parseCoretaxExport(fixture('coretax-export-sample.csv'), 'export.csv');
    assert.strictEqual(r.records.length, 2);
    assert.strictEqual(r.records[0].fakturDate, '2026-11-03');
    assert.strictEqual(r.records[1].fakturDate, '2026-11-05');
});

test('file tanpa kolom wajib ditolak dengan pesan jelas', () => {
    assert.throws(() => parseCoretaxExport(Buffer.from('a,b\n1,2\n'), 'x.csv'), /Nomor Faktur Pajak/);
});

test('Zoho client: token di-cache, custom field di-resolve ke customfield_id, retry 401', async () => {
    clearCaches();
    const mock = h.createZohoMock();
    const client = new ZohoBooksClient(h.zohoConfig({ clientSecret: encrypt('csecret'), refreshToken: encrypt('refresh-ok') }), { fetchImpl: mock.fetchImpl });

    const org = await client.testConnection();
    assert.strictEqual(org.name, 'PT Contoh');
    await client.updateInvoiceCustomFields('5001', { cf_nomor_faktur_pajak: '04002600000000101', cf_status_e_faktur: 'APPROVED' });
    assert.strictEqual(mock.state.tokenCalls, 1);
    const put = mock.state.calls.find(c => c.method === 'PUT');
    assert.strictEqual(put.path, '/books/v3/invoices/5001');
    assert.deepStrictEqual(JSON.parse(put.body), { custom_fields: [
        { customfield_id: '9001', value: '04002600000000101' },
        { customfield_id: '9003', value: 'APPROVED' }
    ] });
    assert.strictEqual(mock.state.invoices['5001'].custom.cf_status_e_faktur, 'APPROVED');
    assert.strictEqual(put.auth, 'Zoho-oauthtoken tok-1');

    mock.state.expireNextToken = true;
    await client.addInvoiceComment('5001', 'halo');
    assert.strictEqual(mock.state.tokenCalls, 2);
    assert.deepStrictEqual(mock.state.invoices['5001'].comments, ['halo']);

    await client.addInvoiceAttachment('5001', 'fp.pdf', Buffer.from('%PDF-1.4 test'));
    assert.strictEqual(mock.state.invoices['5001'].attachments[0].name, 'fp.pdf');

    const found = await client.findInvoiceByNumber('INV-000102');
    assert.strictEqual(found.invoice_id, '5002');
});

test('Zoho client: custom field yang tidak ada menghasilkan error yang menjelaskan', async () => {
    clearCaches();
    const mock = h.createZohoMock();
    const client = new ZohoBooksClient(h.zohoConfig(), { fetchImpl: mock.fetchImpl });
    await assert.rejects(client.updateInvoiceCustomFields('5001', { cf_tidak_ada: 'x' }), /cf_tidak_ada/);
});

test('Zoho client: konfigurasi kurang / refresh token salah', async () => {
    clearCaches();
    const mock = h.createZohoMock();
    await assert.rejects(new ZohoBooksClient(h.zohoConfig({ clientId: '' }), { fetchImpl: mock.fetchImpl }).testConnection(), /Client ID/);
    await assert.rejects(new ZohoBooksClient(h.zohoConfig({ refreshToken: 'salah' }), { fetchImpl: mock.fetchImpl }).testConnection(), /access token/);
});

test('Zoho client: jika PUT /invoices ditolak, otomatis pakai endpoint customfields (JSONString) dan diingat', async () => {
    clearCaches();
    const mock = h.createZohoMock();
    mock.state.rejectInvoicePut = true;
    const client = new ZohoBooksClient(h.zohoConfig(), { fetchImpl: mock.fetchImpl });
    await client.updateInvoiceCustomFields('5002', { cf_nomor_faktur_pajak: '04002600000000102' });
    assert.strictEqual(mock.state.invoices['5002'].custom.cf_nomor_faktur_pajak, '04002600000000102');
    const before = mock.state.calls.filter(c => c.method === 'PUT').length;
    await client.updateInvoiceCustomFields('5002', { cf_status_e_faktur: 'APPROVED' });
    const puts = mock.state.calls.filter(c => c.method === 'PUT').slice(before);
    assert.deepStrictEqual(puts.map(p => p.path), ['/books/v3/invoice/5002/customfields']); // langsung cara yang berhasil
});

test('Opt: A = barang, B = jasa (product_type Zoho); diskon persen', () => {
    const { items } = buildLineItems({ line_items: [
        { name: 'Jasa', rate: 100, quantity: 1, product_type: 'service' },
        { name: 'Barang', rate: 100, quantity: 2, product_type: 'goods', discount: '10%' }
    ] });
    assert.deepStrictEqual(items.map(i => i.Opt), ['B', 'A']);
    assert.strictEqual(items[1].TotalDiscount, 20);
    assert.strictEqual(items[1].TaxBase, 180);
});

test('normalisasi NPWP/NITKU: 15 -> 16 digit, NITKU 21/22, bisa dimatikan', () => {
    const { normalizeTaxId } = require('../lib/efaktur');
    assert.deepStrictEqual(normalizeTaxId('01.234.567.8-901.000'), { tin: '0012345678901000', idtku: '0012345678901000000000', warnings: [] });
    assert.strictEqual(normalizeTaxId('0012345678901000').idtku, '0012345678901000000000');
    assert.deepStrictEqual(normalizeTaxId('0012345678901000000001'), { tin: '0012345678901000', idtku: '0012345678901000000001', warnings: [] });
    assert.strictEqual(normalizeTaxId('012345678901000000001').idtku, '0012345678901000000001'); // NITKU 21 digit
    const off = normalizeTaxId('012345678901000', { padNpwp15: false });
    assert.strictEqual(off.tin, '012345678901000');
    assert.match(off.warnings[0], /15 digit/);
    assert.match(normalizeTaxId('').warnings[0], /kosong/);
});

test('nama barang dari Item Name / Description / gabungan, dengan fallback', () => {
    const { itemName, buildXml } = require('../lib/efaktur');
    const line = { name: 'Sewa Layar', description: 'Periode\n November  2026' };
    assert.strictEqual(itemName(line, 'name'), 'Sewa Layar');
    assert.strictEqual(itemName(line, 'description'), 'Periode November 2026');
    assert.strictEqual(itemName(line, 'name_description'), 'Sewa Layar - Periode November 2026');
    assert.strictEqual(itemName({ name: 'X', description: '' }, 'description'), 'X');   // fallback
    assert.strictEqual(itemName({ name: '', description: 'Y' }, 'name'), 'Y');          // fallback
    assert.strictEqual(itemName({ name: 'Z', description: 'Z' }, 'name_description'), 'Z');
    const inv = { invoice_number: 'I', date: '2026-11-11', cf_npwp: '0012345678901000', line_items: [{ ...line, rate: 100, quantity: 1 }] };
    assert.match(buildXml(inv, { itemNameSource: 'description' }).xml, /<Name>- Periode November 2026<\/Name>/);
    assert.match(buildXml(inv, {}).xml, /<Name>- Sewa Layar<\/Name>/);
});

test('fingerprint v2 ikut description; v1 tetap sama seperti versi lama', () => {
    const base = { date: 'd', total: 1, line_items: [{ name: 'a', description: 'x', rate: 1, quantity: 1 }] };
    const changed = { ...base, line_items: [{ ...base.line_items[0], description: 'y' }] };
    assert.notStrictEqual(invoiceFingerprint(base, 2), invoiceFingerprint(changed, 2));
    assert.strictEqual(invoiceFingerprint(base, 1), invoiceFingerprint(changed, 1));
});
