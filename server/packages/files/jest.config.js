// eslint-disable-next-line @typescript-eslint/no-var-requires
const base = require('../../jest.config')

module.exports = {
  ...base,
  coveragePathIgnorePatterns: ['/Bootstrap/', 'HealthCheckController', '/Infra/FS', '/Domain/Event/'],
  setupFilesAfterEnv: ['./test-setup.ts'],
}
