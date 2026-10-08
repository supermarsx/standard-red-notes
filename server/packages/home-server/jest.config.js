// eslint-disable-next-line @typescript-eslint/no-var-requires
const base = require('../../jest.config')

module.exports = {
  // This list used to name four paths, which made the denominator a
  // hand-maintained allowlist: `CanonicalHomeServerFileResourceAuthorizer.ts`
  // (533 lines, two spec files, 919 lines of assertions, and the file that
  // decides whether a file-resource request is authorized on this topology) and
  // `HomeServerSyncFilesAdapter.ts` (1 238 lines, an 844-line spec) both ran
  // their specs on every suite with no floor able to see them. A glob over
  // `src/Server/` instead, with the type-only modules and the barrel named as
  // exceptions, so a NEW module under `src/Server/` is in the denominator the
  // day it lands rather than the day somebody remembers this file.
  ...base,
  collectCoverageFrom: [
    // `HomeServer.ts` is the composition root the whole single-container and
    // LXC topology boots through; `HomeServerRuntime.ts` is its runtime;
    // `InternalDiagnosticsListener.ts` is the loopback-only listener that
    // serves auth's `/healthcheck/diagnostics` here, one half of an EXPOSURE
    // boundary — an internal route that must not answer the public front door;
    // and the realtime bridge is swapped per topology (Redis today, in-process
    // for the single container). All of them are picked up by this one glob.
    'src/Server/**/*.ts',
    '!src/Server/**/*.spec.ts',
    // Pure `export *` barrel — no statements of its own to cover.
    '!src/Server/index.ts',
    // Type-only: `HomeServerConfiguration.ts` is a 5-line `interface` and
    // `HomeServerInterface.ts` a 16-line one. Neither emits a runtime
    // statement, so in the denominator they are noise, not signal.
    '!src/Server/HomeServerConfiguration.ts',
    '!src/Server/HomeServerInterface.ts',
    // Deliberately NOT widened to `src/**/*.ts`: the only two files that would
    // add are `src/index.ts` (a one-line barrel) and `src/Bootstrap/Env.ts` (a
    // 9-line `AbstractEnv` subclass whose `load()` is a single `dotenv.config()`
    // call with no branch). Both are the legitimate kind of exclusion — adding
    // them would cost a `functions: 100` global for no decision anybody could
    // get wrong.
  ],
  coverageThreshold: {
    // The rest of the denominator keeps the shared 99 / 99 / 100 / 90 floor.
    // Jest subtracts path-keyed files from the global group, so this global
    // judges `HomeServerRuntime.ts`, `InternalDiagnosticsListener.ts` and the
    // WebSocket bridges only — the same set it judged before the glob above
    // widened the denominator, because both newly included files are path-keyed
    // at their measured coverage rather than dropped into the global average.
    ...base.coverageThreshold,
    // MEASURED at 7 suites / 136 tests (recorded in
    // `.orchestration/logs/t92/t92-w3-e2.md`):
    //   statements 69.15   branches 63.94   functions 48.14   lines 69.89
    // Re-measured at 11 suites / 259 tests: 72.19 / 70.63 / 55.55 / 72.89 —
    // comfortably over the floors below, which are left where they were.
    // Each floor is the original measurement minus 1 pp. The shared floor
    // cannot apply to this file — it is ~30 pp below it — so a per-path entry
    // is the only way to gate it at all rather than not gate it.
    './src/Server/HomeServer.ts': {
      statements: 68.15,
      branches: 62.94,
      functions: 47.14,
      lines: 68.89,
    },
    // MEASURED at 11 suites / 259 tests: 92.1 / 92.51 / 95.45 / 93.63, each
    // floor that minus 1 pp. Uncovered on the day it entered the denominator:
    // lines 177, 198, 321, 404, 408, 419, 526. A real shortfall against the
    // shared 99/99/100/90 and recorded as one — the floor is the measurement,
    // not an endorsement. Raise it when you cover those lines; it exists so the
    // 92 cannot quietly become a 40.
    './src/Server/CanonicalHomeServerFileResourceAuthorizer.ts': {
      statements: 91.1,
      branches: 91.51,
      functions: 94.45,
      lines: 92.63,
    },
    // MEASURED at 11 suites / 259 tests: 81.36 / 72.13 / 85.18 / 82.5, each
    // floor that minus 1 pp. The widest gap in this package after
    // `HomeServer.ts`: ~120 uncovered lines across the sync/files adapter,
    // listed in full in the run recorded with this change. Gated at what it
    // actually is rather than left out of the denominator reading 100 %.
    './src/Server/HomeServerSyncFilesAdapter.ts': {
      statements: 80.36,
      branches: 71.13,
      functions: 84.18,
      lines: 81.5,
    },
  },
}
