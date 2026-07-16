// eslint-disable-next-line @typescript-eslint/no-var-requires
const base = require('../../jest.config')

module.exports = {
  ...base,
  coverageThreshold: {
    global: {
      branches: 14,
      functions: 13,
      lines: 14,
      statements: 14,
    },
  },
}
