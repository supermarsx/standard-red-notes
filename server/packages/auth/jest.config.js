// eslint-disable-next-line @typescript-eslint/no-var-requires
const base = require('../../jest.config')

module.exports = {
  ...base,
  // Without this, jest only instruments files some test happens to import, so
  // an entirely untested file is counted as neither covered nor uncovered and
  // the gate silently measures a subset of the package. Naming the sources
  // explicitly makes the denominator the whole of src.
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.spec.ts'],
  coveragePathIgnorePatterns: ['/Bootstrap/', '/Infra/', '/Controller/', '/Projection/', '/Domain/Email/', '/Mapping/'],
  setupFilesAfterEnv: ['./test-setup.ts'],
}
