// eslint-disable-next-line @typescript-eslint/no-var-requires
const base = require('../../common.jest.json')

module.exports = {
  ...base,
  // RATCHET, NOT A TARGET.
  //
  // These numbers are a record of where this package measured on 2026-09-30, minus about two
  // points of margin. They exist so coverage cannot silently fall, and they are not an opinion
  // about where it should be. Do not read 69 as an aspiration: raising it because it looks low
  // invites tests written to move a number, which is the failure mode this package already had.
  // Raise a floor only after real tests have moved the measurement past it.
  //
  // The 100/100/100/100 inherited from `common.jest.json` used to sit here instead, and had never
  // once been evaluated: the `test` script passed no `--coverage`, and a `coverageThreshold` is
  // only checked when coverage is actually collected. The script now collects it, so this gate
  // runs. Measured 71.02 st / 44.95 br / 65.54 fn / 71.36 li over 17 suites / 84 tests.
  coverageThreshold: {
    global: {
      statements: 69,
      branches: 42,
      functions: 63,
      lines: 69,
    },
  },
}
