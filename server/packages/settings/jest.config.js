// eslint-disable-next-line @typescript-eslint/no-var-requires
const base = require('../../jest.config')

module.exports = {
  ...base,
  // Instrument every source file, not only the ones a spec happens to import, so the
  // barrel's missing MuteFailedBackupsEmailsOption re-export cannot hide from the report.
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.spec.ts'],
}
