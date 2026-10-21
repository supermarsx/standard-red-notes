"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TokenEncoder = void 0;
const jsonwebtoken_1 = require("jsonwebtoken");
class TokenEncoder {
    jwtSecret;
    constructor(jwtSecret) {
        this.jwtSecret = jwtSecret;
    }
    encodeExpirableToken(data, expiresIn) {
        return (0, jsonwebtoken_1.sign)(data, this.jwtSecret, { algorithm: 'HS256', expiresIn });
    }
    encodeToken(data) {
        return (0, jsonwebtoken_1.sign)(data, this.jwtSecret, { algorithm: 'HS256' });
    }
}
exports.TokenEncoder = TokenEncoder;
