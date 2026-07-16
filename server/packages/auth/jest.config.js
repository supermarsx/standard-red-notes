// eslint-disable-next-line @typescript-eslint/no-var-requires
const base = require('../../jest.config')

module.exports = {
  ...base,
  coveragePathIgnorePatterns: ['/Bootstrap/', '/Infra/', '/Controller/', '/Projection/', '/Domain/Email/', '/Mapping/'],
  setupFilesAfterEnv: ['./test-setup.ts'],
}
