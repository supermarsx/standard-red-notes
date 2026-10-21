"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TokenDecoder = void 0;
const jsonwebtoken_1 = require("jsonwebtoken");
class TokenDecoder {
    jwtSecret;
    constructor(jwtSecret) {
        this.jwtSecret = jwtSecret;
    }
    decodeToken(token) {
        try {
            return (0, jsonwebtoken_1.verify)(token, this.jwtSecret, {
                algorithms: ['HS256'],
            });
        }
        catch (_error) {
            return undefined;
        }
    }
}
exports.TokenDecoder = TokenDecoder;
