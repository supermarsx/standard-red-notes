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
  // `'/Infra/FS'` used to sit in this list too, and it was the same defect as
  // the `'HealthCheckController'` entry above, one layer down. Note it had no
  // trailing slash, so it was a substring match over a directory name rather
  // than a path prefix — any future `src/Infra/FSomething.ts` would have
  // disappeared with it.
  //
  // What it hid, measured on inclusion:
  //
  //   FSStorageReadiness.ts    100   | 100   | 100   | 100
  //   FSFileUploader.ts         77.12|  73.52|  53.84|  77.18
  //   FSFileDownloader.ts       57.14| 100   |  75   |  53.84
  //   FSFileMover.ts            58.33| 100   |  50   |  54.54
  //   FSFileRemover.ts          19.04|   0   |  33.33|  15
  //
  // `FSStorageReadiness.ts` was already at 100 % from its own spec, which ran
  // on every suite with no floor able to see it — and it is not a persistence
  // adapter at all: it is the readiness decision this package's
  // `AnnotatedHealthCheckController` publishes, the same EXPOSURE boundary the
  // entry above was removed for. `FSFileRemover.ts` had no test whatsoever
  // over code whose entire job is to DELETE the user's files.
  //
  // Specs for `FSFileRemover`, `FSFileMover` and `FSFileDownloader` landed with
  // this change — driven against a real temporary directory rather than a
  // mocked `fs`, because every bug these three can have is in the path they
  // construct or the order in which they stat and remove, and a mock asserts
  // only that some string reached some spy. All three now measure
  // 100/100/100/100, as does `FSStorageReadiness.ts`; all four are pinned
  // below, and `FSFileUploader.ts` is pinned at what it actually is.
  //
  // `/Domain/Event/` and `/Bootstrap/` are unchanged.
  coveragePathIgnorePatterns: ['/Bootstrap/', '/Domain/Event/'],
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
    // The five files that `'/Infra/FS'` used to hide. Path-keyed for the same
    // two reasons as the entry above — a `global` group cannot notice a file
    // LEAVING the denominator (it prints `0 | 0 | 0 | 0` and exits 0), where a
    // path-keyed entry fails with `Jest: Coverage data for ./<path> was not
    // found.` — so restoring that ignore pattern breaks the gate rather than
    // quietly reverting this change.
    //
    // Four of the five are pinned at 100 exactly. These are not aspirational
    // numbers: they are what the new specs measure, and a pin at the ceiling
    // means losing ANY branch fails.
    './src/Infra/FS/FSStorageReadiness.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    './src/Infra/FS/FSFileRemover.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    './src/Infra/FS/FSFileMover.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    './src/Infra/FS/FSFileDownloader.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    // MEASURED at 77.12 / 73.52 / 53.84 / 77.18, each floor that minus 1 pp.
    // A real shortfall and recorded as one — the floor is the measurement, not
    // an endorsement. Uncovered on the day it entered the denominator: lines
    // 31-32, 36-50, 90, 93, 104, 186, 194, 199-205, 223, 228, 242, 247, 263,
    // 274, 282, 300, 318, 327-331. It is 371 lines and does have a spec; the
    // ~46 % of its functions that spec never calls are a separate change with
    // its own measurement. This entry exists so the 77 cannot quietly become a
    // 30, which is precisely what an ignore pattern allowed.
    './src/Infra/FS/FSFileUploader.ts': {
      statements: 76.12,
      branches: 72.52,
      functions: 52.84,
      lines: 76.18,
    },
  },
}
