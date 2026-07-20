// eslint-disable-next-line @typescript-eslint/no-var-requires
const base = require('../../common.jest.json')

module.exports = {
  ...base,
  // Enforced gate. Measured 99.15 st / 98.27 br / 100 fn / 99.12 li; set at the floor with margin.
  // The residual gap is Domain/Logging.ts (its emit path is behind a private compile-time switch)
  // and the unreachable line after the broken abort call in Domain/Operations/DownloadAndDecrypt.ts.
  coverageThreshold: {
    global: {
      branches: 95,
      functions: 95,
      lines: 95,
      statements: 95,
    },
  },
}
