"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getBufferWithEncoding = getBufferWithEncoding;
/**
 * Turns `unencrypted` into a `buffer` with `encoding`.
 * @param unencrypted
 */
function getBufferWithEncoding(unencrypted) {
    if (typeof unencrypted === 'string') {
        const encoding = 'utf-8';
        const buffer = Buffer.from(unencrypted, encoding);
        return { buffer, encoding };
    }
    const { string, encoding } = unencrypted;
    const buffer = Buffer.from(string, encoding);
    return { buffer, encoding };
}
