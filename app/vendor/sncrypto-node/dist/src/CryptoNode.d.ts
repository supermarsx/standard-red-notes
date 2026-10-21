import { Aes256GcmEncrypted, Aes256GcmInput, HexString, CryptoAes256GcmInterface, CryptoSha256Interface, CryptoBase64Interface, Utf8String, Base64String } from '@standardnotes/sncrypto-common';
import { CryptoTotpInterface } from './CryptoTotpInterface';
export declare class CryptoNode implements CryptoAes256GcmInterface<BufferEncoding>, CryptoSha256Interface, CryptoBase64Interface, CryptoTotpInterface {
    aes256GcmEncrypt({ unencrypted, iv, key, aad, }: Aes256GcmInput<BufferEncoding>): Promise<Aes256GcmEncrypted<BufferEncoding>>;
    aes256GcmDecrypt(encrypted: Aes256GcmEncrypted<BufferEncoding>, key: HexString): Promise<string>;
    generateRandomKey(bits: number): Promise<HexString>;
    sha256(text: Utf8String): HexString;
    base64Encode(text: Utf8String): Base64String;
    base64URLEncode(text: Utf8String): Base64String;
    base64Decode(base64String: Base64String): Utf8String;
    generateOtpSecret(): Promise<string>;
    private base32Encode;
    hotpToken(secret: string, counter: number, tokenLength?: number): Promise<string>;
    totpToken(secret: string, timestamp: number, tokenLength?: number, step?: number): Promise<string>;
    private createHmacKey;
    private padStart;
    private signHmac;
    private truncateOTP;
    private base32Decode;
}
