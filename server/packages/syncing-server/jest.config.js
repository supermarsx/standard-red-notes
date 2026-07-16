// eslint-disable-next-line @typescript-eslint/no-var-requires
const base = require('../../jest.config')

module.exports = {
  ...base,
  coveragePathIgnorePatterns: ['/Bootstrap/', 'HealthCheckController', '/Infra/', '/Domain/Email/'],
  setupFilesAfterEnv: ['./test-setup.ts'],
}
