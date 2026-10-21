import { TokenEncoderInterface } from './TokenEncoderInterface';
export declare class TokenEncoder<T> implements TokenEncoderInterface<T> {
    private jwtSecret;
    constructor(jwtSecret: string);
    encodeExpirableToken(data: T, expiresIn: string | number | undefined): string;
    encodeToken(data: T): string;
}
