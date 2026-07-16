// eslint-disable-next-line @typescript-eslint/no-var-requires
const base = require('../../jest.config')

module.exports = {
  ...base,
  coveragePathIgnorePatterns: ['/Bootstrap/', 'HealthCheckController'],
  setupFilesAfterEnv: ['./test-setup.ts'],
}
