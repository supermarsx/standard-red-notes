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
  // evaluated, because the `test` script passed no `--coverage`. Measured 93.33 st / 88.57 br /
  // 62.85 fn / 94.49 li over 6 suites / 11 tests. The function floor is much lower than the
  // statement floor because this package is largely data: feature descriptions, with a handful of
  // accessors over them that no test calls.
  coverageThreshold: {
    global: {
      statements: 91,
      branches: 86,
      functions: 60,
      lines: 92,
    },
  },
}
