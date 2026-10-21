"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProtocolVersion = void 0;
exports.leftVersionGreaterThanOrEqualToRight = leftVersionGreaterThanOrEqualToRight;
var ProtocolVersion;
(function (ProtocolVersion) {
    ProtocolVersion["V001"] = "001";
    ProtocolVersion["V002"] = "002";
    ProtocolVersion["V003"] = "003";
    ProtocolVersion["V004"] = "004";
})(ProtocolVersion || (exports.ProtocolVersion = ProtocolVersion = {}));
/**
 *  -1 if a < b
 *  0 if a == b
 *  1 if a > b
 */
function compareVersions(a, b) {
    const aNum = Number(a);
    const bNum = Number(b);
    return aNum - bNum;
}
function leftVersionGreaterThanOrEqualToRight(a, b) {
    return compareVersions(a, b) >= 0;
}
