// eslint-disable-next-line @typescript-eslint/no-var-requires
const base = require('../../common.jest.json')

module.exports = {
  ...base,
  // RATCHET, NOT A TARGET. See the longer note in `packages/encryption/jest.config.js`.
  //
  // A record of where this package measured on 2026-09-30, minus about two points, so coverage
  // cannot silently fall. Not an opinion about where it should be, and not something to raise
  // because it looks low — raise it only after real tests have moved the measurement past it.
  //
  // The 100/100/100/100 inherited from `common.jest.json` used to apply here and had never been
  // evaluated, because the `test` script passed no `--coverage`. Measured 58.25 st / 53.21 br /
  // 41.60 fn / 58.49 li over 33 suites / 275 tests.
  coverageThreshold: {
    global: {
      statements: 56,
      branches: 51,
      functions: 39,
      lines: 56,
    },
  },
}
