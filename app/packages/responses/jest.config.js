// eslint-disable-next-line @typescript-eslint/no-var-requires
const base = require('../../common.jest.json')

module.exports = {
  ...base,
  // Enforced gate. Measured 99 st / 100 br / 100 fn / 99 li; set at the floor with margin.
  // The residual gap is the transpiled import in Item/RawSyncData.ts, a type-only module.
  coverageThreshold: {
    global: {
      branches: 95,
      functions: 95,
      lines: 95,
      statements: 95,
    },
  },
}
