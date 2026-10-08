// eslint-disable-next-line @typescript-eslint/no-var-requires
const base = require('../../jest.config')

module.exports = {
  ...base,
  // Without this, jest only instruments the files a test happens to import, so untested
  // files are absent from the denominator rather than counted as uncovered. The package
  // reported 100% while its event handlers, S3 infra and the shared-vault valet token
  // middleware were entirely unmeasured.
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.spec.ts'],
  // `'HealthCheckController'` used to sit in this list. The only file it
  // matched is `src/Infra/InversifyExpress/AnnotatedHealthCheckController.ts`,
  // which is not a stub: 71 lines that ping Redis and the active
  // filesystem/S3 capability under a 2 s deadline and answer 503 when either
  // is down. It has a spec; the spec ran on every suite; no floor could see
  // it. MEASURED on inclusion at 95.83 / 91.66 / 90 / 100 — the uncovered
  // function was the deadline callback itself, i.e. the storage-hangs case the
  // timeout exists for. A test for it was added with this change and the file
  // is pinned below.
  coveragePathIgnorePatterns: ['/Bootstrap/', '/Infra/FS', '/Domain/Event/'],
  setupFilesAfterEnv: ['./test-setup.ts'],
  coverageThreshold: {
    ...base.coverageThreshold,
    // Pinned at the measured value, and path-keyed rather than left to the
    // package `global` for the two reasons a `global` floor cannot cover one
    // file: 71 lines cannot move a package average past its headroom, and a
    // `global` group reports `0 | 0 | 0 | 0` and exits 0 when a file leaves
    // the denominator, where a path-keyed entry fails with `Jest: Coverage
    // data for ./<path> was not found.`
    //
    // `branches` is 91.66 and that is the ceiling, not a concession: the one
    // uncovered branch is the `if (timer)` guard in `withTimeout`, whose false
    // arm is UNREACHABLE — `Promise.race` evaluates its array synchronously,
    // so the executor that assigns `timer` has always run by the time
    // `finally` reads it.
    './src/Infra/InversifyExpress/AnnotatedHealthCheckController.ts': {
      statements: 100,
      branches: 91.66,
      functions: 100,
      lines: 100,
    },
  },
}
