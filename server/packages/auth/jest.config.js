// eslint-disable-next-line @typescript-eslint/no-var-requires
const base = require('../../jest.config')

module.exports = {
  ...base,
  // Without this, jest only instruments files some test happens to import, so
  // an entirely untested file is counted as neither covered nor uncovered and
  // the gate silently measures a subset of the package. Naming the sources
  // explicitly makes the denominator the whole of src.
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.spec.ts'],
  coveragePathIgnorePatterns: [
    '/Bootstrap/',
    // `'/Infra/'` used to be flat, and it took 190 source files out of the
    // denominator — 54 of which HAVE specs that run and assert on every suite,
    // with no floor able to see them. The adapter layers below are a defensible
    // exclusion (a TypeORM repository or an `Annotated*Controller` is tested by
    // standing the thing up, not by unit coverage). `/Infra/Diagnostics/` is
    // not: it is two endpoint modules, `AuthReadinessEndpoint.ts` and
    // `AuthRuntimeDiagnosticsEndpoint.ts`, that decide what a diagnostics
    // caller is allowed to see — an EXPOSURE boundary, the same class of
    // decision as api-gateway's `resolveReadinessAnswer`. A negative lookahead
    // keeps the rest of `/Infra/` out and lets exactly that directory in; both
    // files carry per-path floors below so the inherited 99/99/100/90 global
    // neither has to absorb them nor gets to hide a regression in them.
    '/Infra/(?!Diagnostics/)',
    '/Controller/',
    '/Projection/',
    '/Domain/Email/',
    '/Mapping/',
  ],
  setupFilesAfterEnv: ['./test-setup.ts'],
  coverageThreshold: {
    ...base.coverageThreshold,
    // MEASURED, and pinned at the measured value. Jest subtracts a path-keyed
    // file from the `global` group, so these two entries cannot flatter the
    // package average either — and unlike `global`, a path-keyed entry fails
    // loudly (`Jest: Coverage data for ./<path> was not found.`) if the file
    // ever leaves the denominator again, where a `global` group would simply
    // print `0 | 0 | 0 | 0` and exit 0.
    //
    // `branches` is 94.73 rather than 100 and that is the measured value, not a
    // concession: the one uncovered branch is the `if (timer)` guard in this
    // module's private `withTimeout`, and its false arm is UNREACHABLE —
    // `Promise.race` evaluates its array synchronously, so the executor that
    // assigns `timer` has always run by the time `finally` reads it. Pinned
    // exactly, so losing any OTHER branch still fails.
    './src/Infra/Diagnostics/AuthReadinessEndpoint.ts': {
      statements: 100,
      branches: 94.73,
      functions: 100,
      lines: 100,
    },
    './src/Infra/Diagnostics/AuthRuntimeDiagnosticsEndpoint.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
  },
}
