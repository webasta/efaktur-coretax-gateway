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

const buildLineItems = (inv) => {
    let totalVat = 0;
    let totalTaxBase = 0;
    const items = (inv.line_items || [])
        .filter(line => (Number(line.rate) || 0) > 0)
        .map(line => {
            const price = Number(line.rate) || 0;
            const qty = Number(line.quantity) || 0;
            const discount = Number(line.discount) || 0;
            const taxBase = round2(price * qty - discount);
            // Kode transaksi 04 (PMK 131/2024): DPP Nilai Lain = 11/12 x harga jual,
            // PPN = 12% x DPP Nilai Lain (efektif 11% dari harga jual).
            const otherTaxBase = round2(taxBase * 11 / 12);
            const vatRate = 12;
            const vat = round2(otherTaxBase * vatRate / 100);
            totalVat += vat;
            totalTaxBase += taxBase;
            const isService = line.item_type === 'service';
            // Catatan: pemetaan Opt & Unit dipertahankan seperti versi 1.0.0.
            return {
                Opt: isService ? 'A' : 'B',
                Code: '000000', Name: `- ${line.name || ''}`,
                Unit: isService ? 'UM.0018' : 'UM.0033',
                Price: price, Qty: qty, TotalDiscount: discount, TaxBase: taxBase,
                OtherTaxBase: otherTaxBase, VATRate: vatRate, VAT: vat, STLGRate: 0, STLG: 0
            };
        });
    return { items, totalVat: round2(totalVat), totalTaxBase: round2(totalTaxBase) };
};

const buildXml = (inv, sellerConfig) => {
    const buyerNpwp = digitsOnly(getCustomField(inv, 'cf_npwp'));
    const invoiceDate = inv.date ? String(inv.date).split('T')[0] : '';
    const { items, totalVat, totalTaxBase } = buildLineItems(inv);

    const doc = create({ version: '1.0', encoding: 'UTF-8', standalone: 'yes' })
        .ele('TaxInvoiceBulk', { 'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance', 'xsi:noNamespaceSchemaLocation': 'TaxInvoice.xsd' });

    doc.ele('TIN').txt(sellerConfig.sellerTin || '');
    const ti = doc.ele('ListOfTaxInvoice').ele('TaxInvoice');
    ti.ele('TaxInvoiceDate').txt(invoiceDate);
    ti.ele('TaxInvoiceOpt').txt('Normal');
    ti.ele('TrxCode').txt('04');
    // RefDesc = nomor invoice Zoho. Kolom "Referensi" inilah yang dipakai untuk mencocokkan
    // hasil ekspor Coretax kembali ke invoice Zoho.
    ti.ele('RefDesc').txt(inv.invoice_number || '');
    ti.ele('SellerIDTKU').txt(sellerConfig.sellerTku || '');
    ti.ele('BuyerTin').txt(buyerNpwp);
    ti.ele('BuyerDocument').txt('TIN');
    ti.ele('BuyerCountry').txt('IND');
    ti.ele('BuyerName').txt(inv.customer_name || '');
    ti.ele('BuyerAdress').txt(inv.billing_address ? (inv.billing_address.address || '') : '');
    ti.ele('BuyerEmail').txt(inv.email || '');
    ti.ele('BuyerIDTKU').txt(buyerNpwp ? buyerNpwp + '000000' : '');

    const list = ti.ele('ListOfGoodService');
    items.forEach(item => {
        const gs = list.ele('GoodService');
        Object.entries(item).forEach(([k, v]) => gs.ele(k).txt(String(v)));
    });

    return { xml: doc.end({ prettyPrint: true }), totalVat, totalTaxBase, itemCount: items.length, buyerNpwp };
};

module.exports = { buildXml, buildLineItems, getCustomField, invoiceFingerprint, digitsOnly, round2 };
