// eslint-disable-next-line @typescript-eslint/no-var-requires
const base = require('../../jest.config')

module.exports = {
  ...base,
  // Instrument every source file, not only the ones a spec happens to import. Without
  // this the inherited 90/100/99/99 gate measured only the loaded subset, so an entirely
  // untested module scored 100% by being absent from the denominator.
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.spec.ts'],
}
