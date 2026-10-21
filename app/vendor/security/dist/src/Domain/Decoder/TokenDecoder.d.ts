import { TokenDecoderInterface } from './TokenDecoderInterface';
export declare class TokenDecoder<T> implements TokenDecoderInterface<T> {
    private jwtSecret;
    constructor(jwtSecret: string);
    decodeToken(token: string): T | undefined;
}
