// Enkripsi AES-256-GCM untuk kredensial yang disimpan di database.json.
// Kunci diambil dari APP_SECRET; jika kosong, dibuat sekali dan disimpan di file .app-secret.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

const PREFIX = 'enc:v1:';
let key;

const getKey = () => {
    if (key) return key;
    let secret = config.appSecret;
    if (!secret) {
        const file = path.join(config.dataDir, '.app-secret');
        if (!fs.existsSync(file)) {
            fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
        }
        secret = fs.readFileSync(file, 'utf8').trim();
    }
    key = crypto.createHash('sha256').update(secret).digest();
    return key;
};

const encrypt = (plain) => {
    if (!plain) return '';
    if (String(plain).startsWith(PREFIX)) return plain;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
    const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
    return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
};

const decrypt = (value) => {
    if (!value) return '';
    if (!String(value).startsWith(PREFIX)) return value; // data lama yang belum terenkripsi
    const raw = Buffer.from(String(value).slice(PREFIX.length), 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
};

module.exports = { encrypt, decrypt };
