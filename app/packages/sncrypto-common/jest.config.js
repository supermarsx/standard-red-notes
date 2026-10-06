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
  // The inherited `global` floor is only a gate while the denominator is non-empty: Jest
  // prints `All files 0 | 0 | 0 | 0` and exits 0 when no file was instrumented at all, so
  // with `Common/Utils.ts` the single member of this denominator the floor is one rename
  // away from passing over nothing (moving `timingSafeEqual` into a `Common/index.ts`
  // excluded above would do it). Naming the file as its own threshold closes that: Jest
  // fails a path-keyed threshold whose path produced no coverage data, so the gate can no
  // longer report success for an empty measurement.
  coverageThreshold: {
    ...base.coverageThreshold,
    './src/Common/Utils.ts': { branches: 100, functions: 100, lines: 100, statements: 100 },
  },
}
