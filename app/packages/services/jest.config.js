// eslint-disable-next-line @typescript-eslint/no-var-requires
const base = require('../../common.jest.json')

// Coverage is collected for a WHOLE-suite run and skipped for a filtered one.
//
// Why it is decided here instead of on the command line: a `coverageThreshold`
// is only ever evaluated when coverage is actually collected, and this
// workspace's `test` script (`jest`, no `--coverage`) is not ours to change.
// The global floor below predates this file's current form and has never once
// been evaluated — an inert gate that reads green because nothing runs it. The
// realtime directory floors added below would have inherited exactly that.
//
// A filtered run legitimately exercises a subset, so it must not be judged
// against the floors. `SRN_COVERAGE=1` forces collection on (used to measure
// and to prove the floors bite), `SRN_COVERAGE=0` forces it off.
function hasTestFilter(argv) {
  const filterFlags =
    /^(-t|--testNamePattern|--testPathPatterns?|--onlyChanged|--changedSince|--findRelatedTests|--runTestsByPath|--shard)(=|$)/
  return argv.some((argument, index) => {
    if (filterFlags.test(argument)) {
      return true
    }
    if (argument.startsWith('-')) {
      return false
    }
    // A bare word straight after a `--flag` with no `=` is that flag's VALUE,
    // not a test pattern (`--config jest.config.js` is exactly that shape).
    // Reading it as a pattern would switch the gate off for the real suite.
    const previous = argv[index - 1]
    if (previous !== undefined && previous.startsWith('-') && !previous.includes('=')) {
      return false
    }
    return true
  })
}

const forced = process.env.SRN_COVERAGE
const collectCoverage = forced === '1' ? true : forced === '0' ? false : !hasTestFilter(process.argv.slice(2))

module.exports = {
  ...base,
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
  },
  collectCoverage,
  coverageReporters: ['text', 'text-summary'],
  // All floors are MEASURED minus 2 pp, recorded in
  // `.orchestration/logs/t92/t92-w3-e2.md`. Jest subtracts path-keyed files
  // from the global group, so `global` below judges the REST of the workspace,
  // measured separately at 40.47 / 32.25 / 27.75 / 40.54 once the two realtime
  // directories are taken out of it.
  coverageThreshold: {
    global: {
      statements: 38.47,
      branches: 30.25,
      functions: 25.75,
      lines: 38.54,
    },
    // measured 88.88 / 84.75 / 94.23 / 88.74
    './src/Domain/Api/': {
      statements: 86.88,
      branches: 82.75,
      functions: 92.23,
      lines: 86.74,
    },
    // measured 87.9 / 86.54 / 93.67 / 87.63
    './src/Domain/Invite/': {
      statements: 85.9,
      branches: 84.54,
      functions: 91.67,
      lines: 85.63,
    },
    // Nine lines, and here for a reason that has nothing to do with its size.
    //
    // `TypeCheck.ts` carried a whole-file `/* istanbul ignore file */` pragma —
    // a coverage exclusion that lives IN THE SOURCE, where no sweep of this
    // file or any other `jest.config.js` can see it. 31 files in this repo
    // carry that pragma; 28 of them are in this package, and this was the only
    // one hiding logic a spec already covers. `TypeCheck.spec.ts` asserts both
    // arms of the `isMobileDevice` type predicate and runs on every suite, so
    // the pragma meant the spec could have been deleted with no gate moving.
    // The pragma is gone and the file measures 100/100/100/100.
    //
    // The entry below is what stops that from silently coming back. A `global`
    // floor cannot: this package's global has ~2 pp of headroom over a ~5 000
    // statement denominator, so nine lines leaving it is invisible, and a
    // `global` group reports `0 | 0 | 0 | 0` and exits 0 when a file is not
    // instrumented at all. A path-keyed entry fails loudly instead — re-adding
    // the pragma produces `Jest: Coverage data for
    // ./src/Domain/Device/TypeCheck.ts was not found.` — so the exclusion
    // cannot be restored without breaking the build.
    './src/Domain/Device/TypeCheck.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
  },
}
