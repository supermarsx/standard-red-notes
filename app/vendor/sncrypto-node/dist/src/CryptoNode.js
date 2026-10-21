"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CryptoNode = void 0;
const crypto_1 = require("crypto");
const Utils_1 = require("./Utils");
class CryptoNode {
    async aes256GcmEncrypt({ unencrypted, iv, key, aad = '', }) {
        const { buffer: dataBuffer, encoding } = (0, Utils_1.getBufferWithEncoding)(unencrypted);
        const ivBuffer = Buffer.from(iv, 'hex');
        const keyBuffer = Buffer.from(key, 'hex');
        const cipher = (0, crypto_1.createCipheriv)('aes-256-gcm', keyBuffer, ivBuffer);
        const aadBuffer = Buffer.from(aad, 'hex');
        cipher.setAAD(aadBuffer);
        const ciphertext = Buffer.concat([cipher.update(dataBuffer), cipher.final()]).toString('base64');
        const tag = cipher.getAuthTag().toString('hex');
        return { iv, tag, aad, ciphertext, encoding };
    }
    async aes256GcmDecrypt(encrypted, key) {
        const { iv, tag, ciphertext, encoding, aad } = encrypted;
        const decipher = (0, crypto_1.createDecipheriv)('aes-256-gcm', Buffer.from(key, 'hex'), Buffer.from(iv, 'hex'));
        decipher.setAuthTag(Buffer.from(tag, 'hex'));
        decipher.setAAD(Buffer.from(aad, 'hex'));
        const decrypted = Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]);
        return decrypted.toString(encoding);
    }
    async generateRandomKey(bits) {
        const bytes = bits / 8;
        const buf = (0, crypto_1.randomBytes)(bytes);
        return buf.toString('hex');
    }
    sha256(text) {
        const hash = (0, crypto_1.createHash)('sha256').update(text);
        return hash.digest('hex');
    }
    base64Encode(text) {
        const { buffer } = (0, Utils_1.getBufferWithEncoding)({ string: text, encoding: 'utf8' });
        return buffer.toString('base64');
    }
    base64URLEncode(text) {
        const { buffer } = (0, Utils_1.getBufferWithEncoding)({ string: text, encoding: 'utf8' });
        return buffer.toString('base64url');
    }
    base64Decode(base64String) {
        const { buffer } = (0, Utils_1.getBufferWithEncoding)({ string: base64String, encoding: 'base64' });
        return buffer.toString('utf8');
    }
    async generateOtpSecret() {
        const bits = 160;
        const bytes = bits / 8;
        const secretBytes = (0, crypto_1.randomBytes)(bytes);
        const secret = this.base32Encode(secretBytes.buffer);
        return secret;
    }
    base32Encode(input) {
        const RFC4648 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
        const length = input.byteLength;
        const buffer = new Uint8Array(input);
        let bitIdx = 0;
        let currentVal = 0;
        let output = '';
        for (let i = 0; i < length; i++) {
            currentVal = (currentVal << 8) | buffer[i];
            bitIdx += 8;
            while (bitIdx >= 5) {
                output += RFC4648[(currentVal >>> (bitIdx - 5)) & 31];
                bitIdx -= 5;
            }
        }
        if (bitIdx > 0) {
            output += RFC4648[(currentVal << (5 - bitIdx)) & 31];
        }
        while (output.length % 8 > 0) {
            output += '=';
        }
        return output;
    }
    async hotpToken(secret, counter, tokenLength = 6) {
        const bytes = new Uint8Array(this.base32Decode(secret));
        const secretKey = await this.createHmacKey(bytes);
        const counterArray = this.padStart(counter);
        const hs = await this.signHmac(secretKey, counterArray);
        const sNum = this.truncateOTP(hs);
        const padded = ('0'.repeat(tokenLength) + (sNum % 10 ** tokenLength)).slice(-tokenLength);
        return padded;
    }
    async totpToken(secret, timestamp, tokenLength = 6, step = 30) {
        const timeStep = Math.floor(timestamp / (step * 1000));
        return this.hotpToken(secret, timeStep, tokenLength);
    }
    async createHmacKey(bytes) {
        return Buffer.from(bytes);
    }
    padStart(counter) {
        const buffer = new ArrayBuffer(8);
        const bView = new DataView(buffer);
        const byteString = '0'.repeat(64);
        const bCounter = (byteString + counter.toString(2)).slice(-64);
        for (let byte = 0; byte < 64; byte += 8) {
            const byteValue = parseInt(bCounter.slice(byte, byte + 8), 2);
            bView.setUint8(byte / 8, byteValue);
        }
        return buffer;
    }
    async signHmac(key, data) {
        const hmac = (0, crypto_1.createHmac)('sha1', key);
        hmac.update(Buffer.from(data));
        return hmac.digest().buffer;
    }
    truncateOTP(hsBuffer) {
        const hs = new Uint8Array(hsBuffer);
        const offset = hs[19] & 0b1111;
        const P = ((hs[offset] & 0x7f) << 24) | (hs[offset + 1] << 16) | (hs[offset + 2] << 8) | hs[offset + 3];
        const pString = P.toString(2);
        const Snum = parseInt(pString, 2);
        return Snum;
    }
    base32Decode(input) {
        const RFC4648 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
        const cleanInput = input.toUpperCase().replace(/=+$/, '');
        let bits = 0;
        let value = 0;
        const output = new Uint8Array(Math.ceil(cleanInput.length * 5 / 8));
        let outputIndex = 0;
        for (let i = 0; i < cleanInput.length; i++) {
            const char = cleanInput[i];
            const index = RFC4648.indexOf(char);
            if (index === -1) {
                throw new Error(`Invalid base32 character: ${char}`);
            }
            value = (value << 5) | index;
            bits += 5;
            if (bits >= 8) {
                output[outputIndex++] = (value >>> (bits - 8)) & 255;
                bits -= 8;
            }
        }
        return output.buffer;
    }
}
exports.CryptoNode = CryptoNode;
