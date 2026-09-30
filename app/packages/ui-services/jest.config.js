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
  // evaluated, because the `test` script passed no `--coverage`. Measured 44.13 st / 42.33 br /
  // 34.77 fn / 44.38 li over 19 suites / 150 tests.
  coverageThreshold: {
    global: {
      statements: 42,
      branches: 40,
      functions: 32,
      lines: 42,
    },
  },
}
