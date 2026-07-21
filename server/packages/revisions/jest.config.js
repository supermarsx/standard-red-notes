// eslint-disable-next-line @typescript-eslint/no-var-requires
const base = require('../../jest.config')

module.exports = {
  ...base,
  coveragePathIgnorePatterns: ['/Bootstrap/', '/Controller/', 'HealthCheckController', '/Infra/', '/Mapping/'],
  // Instrument every non-ignored source file, not only the ones a spec happens to import.
  // Without this the package reported 100/100/100/100 while really measuring 83.73
  // statements — five domain event handlers were absent from the denominator entirely.
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.spec.ts'],
}
