// Konversi invoice Zoho Books -> XML Faktur Pajak Keluaran (format impor Coretax).
const crypto = require('crypto');
const { create } = require('xmlbuilder2');

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// Ambil nilai custom field dari payload invoice Zoho. Webhook Zoho bisa mengirimnya
// sebagai key tingkat atas (cf_xxx), di custom_field_hash, atau di array custom_fields.
const getCustomField = (invoice, apiName) => {
    if (!invoice || !apiName) return '';
    if (invoice[apiName] !== undefined && invoice[apiName] !== null) return invoice[apiName];
    if (invoice.custom_field_hash && invoice.custom_field_hash[apiName] !== undefined) {
        return invoice.custom_field_hash[apiName];
    }
    const found = (invoice.custom_fields || []).find(f => f.api_name === apiName || f.placeholder === apiName);
    return found ? found.value : '';
};

const digitsOnly = (v) => (v === undefined || v === null ? '' : String(v).replace(/[^0-9]/g, ''));

// Sidik jari isi invoice yang relevan untuk pajak. Dipakai untuk mendeteksi webhook berulang
// (mis. terpicu ulang karena gateway sendiri meng-update custom field di Zoho).
const invoiceFingerprint = (inv) => {
    const relevant = {
        date: inv.date, customer: inv.customer_name, npwp: digitsOnly(getCustomField(inv, 'cf_npwp')),
        total: inv.total,
        lines: (inv.line_items || []).map(l => [l.name, l.rate, l.quantity, l.discount, l.tax_percentage, l.item_type])
    };
    return crypto.createHash('sha256').update(JSON.stringify(relevant)).digest('hex');
};

// Barang atau jasa? Zoho Books memakai product_type ('goods' | 'service') pada line item.
const isServiceLine = (line) => line.product_type === 'service' || line.item_type === 'service';

// Diskon Zoho bisa berupa nominal (angka) atau persen ("10%").
const lineDiscount = (line, gross) => {
    if (line.discount_amount !== undefined && line.discount_amount !== '') return Number(line.discount_amount) || 0;
    const d = line.discount;
    if (typeof d === 'string' && d.trim().endsWith('%')) return round2(gross * (parseFloat(d) || 0) / 100);
    return Number(d) || 0;
};

const buildLineItems = (inv) => {
    let totalVat = 0;
    let totalTaxBase = 0;
    const items = (inv.line_items || [])
        .filter(line => (Number(line.rate) || 0) > 0)
        .map(line => {
            const price = Number(line.rate) || 0;
            const qty = Number(line.quantity) || 0;
            const discount = lineDiscount(line, price * qty);
            const taxBase = round2(price * qty - discount);
            // Kode transaksi 04 (PMK 131/2024): DPP Nilai Lain = 11/12 x harga jual,
            // PPN = 12% x DPP Nilai Lain (efektif 11% dari harga jual).
            const otherTaxBase = round2(taxBase * 11 / 12);
            const vatRate = 12;
            const vat = round2(otherTaxBase * vatRate / 100);
            totalVat += vat;
            totalTaxBase += taxBase;
            return {
                Opt: isServiceLine(line) ? 'B' : 'A', // template DJP: A = Barang, B = Jasa
                Code: '000000', Name: `- ${line.name || ''}`,
                Unit: 'UM.0033',
                Price: price, Qty: qty, TotalDiscount: discount, TaxBase: taxBase,
                OtherTaxBase: otherTaxBase, VATRate: vatRate, VAT: vat, STLGRate: 0, STLG: 0
            };
        });
    return { items, totalVat: round2(totalVat), totalTaxBase: round2(totalTaxBase) };
};

/**
 * Normalisasi NPWP & NITKU ke format Coretax (NPWP 16 digit, NITKU 22 digit).
 * - NPWP 15 digit (format lama) -> ditambah '0' di depan jika padNpwp15 aktif.
 * - Jika yang tersimpan sudah NITKU (21/22 digit), NPWP diambil dari 15/16 digit pertama.
 */
const normalizeTaxId = (raw, { padNpwp15 = true } = {}) => {
    let d = digitsOnly(raw);
    const warnings = [];
    let idtku = '';
    if (d.length === 22 || d.length === 21) { idtku = d; d = d.slice(0, d.length - 6); }
    if (d.length === 15 && padNpwp15) d = '0' + d;
    if (idtku.length === 21 && padNpwp15) idtku = '0' + idtku;
    if (!idtku && d) idtku = d + '000000';
    if (d && d.length !== 16) warnings.push(`NPWP ${d.length} digit (Coretax butuh 16 digit)`);
    if (!d) warnings.push('NPWP pembeli kosong (custom field cf_npwp)');
    return { tin: d, idtku, warnings };
};

const buildXml = (inv, sellerConfig) => {
    const padNpwp15 = sellerConfig.padNpwp15 !== false;
    const buyer = normalizeTaxId(getCustomField(inv, 'cf_npwp'), { padNpwp15 });
    const seller = normalizeTaxId(sellerConfig.sellerTku || sellerConfig.sellerTin, { padNpwp15 });
    const sellerTin = normalizeTaxId(sellerConfig.sellerTin, { padNpwp15 }).tin;
    const warnings = [...buyer.warnings];
    if (!sellerTin || sellerTin.length !== 16) warnings.push('NPWP penjual belum 16 digit (Pengaturan)');

    const invoiceDate = inv.date ? String(inv.date).split('T')[0] : '';
    const { items, totalVat, totalTaxBase } = buildLineItems(inv);

    const doc = create({ version: '1.0', encoding: 'UTF-8', standalone: 'yes' })
        .ele('TaxInvoiceBulk', { 'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance', 'xsi:noNamespaceSchemaLocation': 'TaxInvoice.xsd' });

    doc.ele('TIN').txt(sellerTin);
    const ti = doc.ele('ListOfTaxInvoice').ele('TaxInvoice');
    // Urutan elemen mengikuti template resmi DJP (Sample Faktur PK Template v1.4 / Converter v1.6).
    ti.ele('TaxInvoiceDate').txt(invoiceDate);
    ti.ele('TaxInvoiceOpt').txt('Normal');
    ti.ele('TrxCode').txt('04');
    ti.ele('AddInfo');
    ti.ele('CustomDoc');
    ti.ele('CustomDocMonthYear');
    // RefDesc = nomor invoice Zoho. Kolom "Referensi" inilah yang dipakai untuk mencocokkan
    // hasil ekspor Coretax kembali ke invoice Zoho.
    ti.ele('RefDesc').txt(inv.invoice_number || '');
    ti.ele('FacilityStamp');
    ti.ele('SellerIDTKU').txt(seller.idtku);
    ti.ele('BuyerTin').txt(buyer.tin);
    ti.ele('BuyerDocument').txt('TIN');
    ti.ele('BuyerCountry').txt('IDN');
    ti.ele('BuyerDocumentNumber');
    ti.ele('BuyerName').txt(inv.customer_name || '');
    ti.ele('BuyerAdress').txt(inv.billing_address ? (inv.billing_address.address || '') : '');
    ti.ele('BuyerEmail').txt(inv.email || '');
    ti.ele('BuyerIDTKU').txt(buyer.idtku);

    const list = ti.ele('ListOfGoodService');
    items.forEach(item => {
        const gs = list.ele('GoodService');
        Object.entries(item).forEach(([k, v]) => gs.ele(k).txt(String(v)));
    });

    return { xml: doc.end({ prettyPrint: true }), totalVat, totalTaxBase, itemCount: items.length, buyerNpwp: buyer.tin, warnings };
};

module.exports = { buildXml, buildLineItems, normalizeTaxId, isServiceLine, getCustomField, invoiceFingerprint, digitsOnly, round2 };
