// eslint-disable-next-line @typescript-eslint/no-var-requires
const base = require('../../jest.config')

module.exports = {
  ...base,
  // Instrument every source file, not only the ones a spec happens to import. Without
  // this the package reported 100/100/100/100 while really measuring 68.42 statements —
  // four untested modules were absent from the denominator rather than counted against it.
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.spec.ts'],
  // The 14/13/14/14 override that used to sit here was dead weight even against the
  // loaded-only denominator; the whole source now clears the inherited 90/100/99/99 gate.
}
