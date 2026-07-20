// eslint-disable-next-line @typescript-eslint/no-var-requires
const base = require('../../common.jest.json')

module.exports = {
  ...base,
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
  },
  // Enforced gate (this was previously `{}`, which disabled the inherited threshold entirely
  // even though the test script already passed --coverage). Measured 98.36 st / 91.85 br /
  // 98.76 fn / 98.35 li; set at the floor with margin. The branch floor is lower because the
  // remaining gaps are unreachable Result.fail paths in HttpService.refreshSession and the
  // content-type fallback in FetchRequestHandler.
  coverageThreshold: {
    global: {
      branches: 90,
      functions: 95,
      lines: 95,
      statements: 95,
    },
  },
}
