// eslint-disable-next-line @typescript-eslint/no-var-requires
const base = require('../../jest.config')

module.exports = {
  ...base,
  coveragePathIgnorePatterns: ['/Bootstrap/', 'HealthCheckController'],
  setupFilesAfterEnv: ['./test-setup.ts'],
  // This package ran 2 934 tests with NO coverage gate at all: its `test`
  // script had no `--coverage`, so the shared 99/99/100/90 floor in
  // `../../jest.config.js` was inherited and never once evaluated. The script
  // now collects coverage, and these floors replace the inherited ones.
  //
  // MEASURED at 113 suites / 2 934 tests (recorded in
  // `.orchestration/logs/t92/t92-w3-e2.md`):
  //   statements 86.95   branches 79.54   functions 89.84   lines 87.2
  // Each floor is that minus 1 pp. The shared 99/99/100/90 cannot apply here:
  // this package is ~13 pp below it, and adopting it would mean a permanently
  // red workspace rather than a gate.
  //
  // Known limit, deliberately left as it stands: there is no
  // `collectCoverageFrom`, so the denominator is only the files the tests
  // actually load. A brand-new file with no test does not move these numbers.
  // Widening the denominator is a separate change with its own re-measurement.
  coverageThreshold: {
    global: {
      statements: 85.95,
      branches: 78.54,
      functions: 88.84,
      lines: 86.2,
    },
  },
}
