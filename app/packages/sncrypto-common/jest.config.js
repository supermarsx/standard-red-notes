// eslint-disable-next-line @typescript-eslint/no-var-requires
const base = require('../../common.jest.json')

module.exports = {
  ...base,
  // `Types/SodiumTag.ts` and `Types/SodiumConstant.ts` are constant tables with no logic: an
  // enum and a frozen record of libsodium byte lengths. They are out of the denominator so the
  // inherited 100/100/100/100 floor stays a real gate over the code that has behaviour — which
  // in this package is `Common/Utils.ts` alone. Everything else under src is type-only and
  // emits nothing to instrument.
  collectCoverageFrom: ['src/**/*.ts', '!**/index.ts', '!src/Types/SodiumTag.ts', '!src/Types/SodiumConstant.ts'],
}
