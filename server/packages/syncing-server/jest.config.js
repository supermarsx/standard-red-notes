// eslint-disable-next-line @typescript-eslint/no-var-requires
const base = require('../../jest.config')

module.exports = {
  ...base,
  // Without this, jest only instruments the files a test happens to import, so untested
  // files are absent from the denominator rather than counted as uncovered. The package
  // reported 100% while its mappers and event handlers were entirely unmeasured.
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.spec.ts'],
  coveragePathIgnorePatterns: ['/Bootstrap/', 'HealthCheckController', '/Infra/', '/Domain/Email/'],
  setupFilesAfterEnv: ['./test-setup.ts'],
}
