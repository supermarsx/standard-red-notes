// eslint-disable-next-line @typescript-eslint/no-var-requires
const base = require('../../jest.config')

module.exports = {
  ...base,
  // `'HealthCheckController'` used to sit in this list. That substring took
  // `src/Controller/HealthCheckController.ts` out of the denominator entirely —
  // the file that owns `resolveReadinessAnswer`, the ONE composition of the
  // `/healthcheck/readiness` answer: both the 200/503 rule and the rule that
  // withholds `checks.services`/`checks.gateway.realtime` (the internal service
  // topology) from the public front door. Its spec ran and asserted the whole
  // time; only the floor was blind, so the tests could have been deleted and
  // this gate would not have moved. MEASURED at 100/100/100/100 once included,
  // and pinned as such below.
  coveragePathIgnorePatterns: ['/Bootstrap/'],
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
  // Re-measured at 129 suites / 3 403 tests with HealthCheckController.ts back
  // in the denominator: 87.73 / 80.66 / 90.28 / 87.96 — the floors below are
  // unchanged and now carry ~1.8 pp more headroom than when they were set.
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
    // A path-keyed floor, not a reliance on the global one, for two reasons.
    //
    // 1. This file is ~100 of roughly 11 000 instrumented statements. At the
    //    global floor it could lose every test it has and move the package
    //    average by well under the 1.8 pp of headroom above — an unfailable
    //    floor over an EXPOSURE boundary.
    // 2. A `global` group cannot notice a file leaving the denominator: jest
    //    prints `0 | 0 | 0 | 0` and exits 0 when nothing is instrumented. A
    //    path-keyed entry fails loudly instead —
    //    `Jest: Coverage data for ./src/Controller/HealthCheckController.ts was
    //    not found.` — so putting this file back behind an ignore pattern, or
    //    renaming it out from under its spec, breaks the gate rather than
    //    quietly emptying it.
    //
    // Jest subtracts a path-keyed file from the `global` group, so this entry
    // does not flatter the average above either way. 100 is the measured value;
    // it is a pin, not an aspiration — if a branch here genuinely cannot be
    // reached from a test, that is a reason to simplify the function, not to
    // lower this number.
    './src/Controller/HealthCheckController.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
  },
}
