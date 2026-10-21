"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DeterministicSelector = void 0;
class DeterministicSelector {
    CHAR_0_CODE = 48;
    select(inputKey, values) {
        const firstChar = inputKey[0];
        const firstCharCode = firstChar.charCodeAt(0);
        const normalizedCode = firstCharCode - this.CHAR_0_CODE;
        const index = normalizedCode % values.length;
        return values[index];
    }
}
exports.DeterministicSelector = DeterministicSelector;
