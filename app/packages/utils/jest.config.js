// eslint-disable-next-line @typescript-eslint/no-var-requires
const base = require('../../common.jest.json')

module.exports = {
  ...base,
  testEnvironment: 'jsdom',
  // Enforced gate (the previous 4/4/24/25 was never evaluated because the test script did not
  // pass --coverage). Measured 99.21 st / 93.06 br / 98.68 fn / 99.19 li; set at the floor with
  // margin. The branch floor is lower because the remaining gaps are environment fallbacks that
  // cannot be reached under jsdom (missing Intl, non-browser global scope).
  coverageThreshold: {
    global: {
      branches: 90,
      functions: 95,
      lines: 95,
      statements: 95,
    },
  },
}
