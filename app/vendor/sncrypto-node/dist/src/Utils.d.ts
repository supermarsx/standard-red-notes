import { Unencrypted } from '@standardnotes/sncrypto-common';
/**
 * Turns `unencrypted` into a `buffer` with `encoding`.
 * @param unencrypted
 */
export declare function getBufferWithEncoding(unencrypted: Unencrypted<BufferEncoding>): {
    buffer: Buffer;
    encoding: BufferEncoding;
};
