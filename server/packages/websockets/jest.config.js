// eslint-disable-next-line @typescript-eslint/no-var-requires
const base = require('../../jest.config')

module.exports = {
  ...base,
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.spec.ts'],
  coveragePathIgnorePatterns: ['/Bootstrap/', '/InversifyExpressUtils/'],
  setupFilesAfterEnv: ['./test-setup.ts'],
}
