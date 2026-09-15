const pathsToModuleNameMapper = require('ts-jest').pathsToModuleNameMapper
const tsConfig = require('./tsconfig.json')

const pathsFromTsconfig = tsConfig.compilerOptions.paths

// Coverage is collected for a WHOLE-suite run and skipped for a filtered one.
//
// Why it is decided here instead of on the command line: a `coverageThreshold`
// is only ever evaluated when coverage is actually collected, and this
// workspace's `test` script (`jest --config jest.config.js`, no `--coverage`)
// is what CI runs. Registering the realtime floors below without collecting
// coverage would produce a gate that reads green because nothing runs it.
//
// The denominator is deliberately just the two realtime directories, so the
// >4.7k-test suite pays instrumentation for ~40 files rather than the whole
// app. A filtered run legitimately exercises a subset, so it must not be
// judged against the floors. `SRN_COVERAGE=1` forces collection on (used to
// measure the floors and to prove they bite), `SRN_COVERAGE=0` forces it off.
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
    // not a test pattern — `--config jest.config.js` is exactly that shape.
    // Reading it as a pattern would switch the gate off for the real suite.
    const previous = argv[index - 1]
    if (previous !== undefined && previous.startsWith('-') && !previous.includes('=')) {
      return false
    }
    return true
  })
}

const forcedCoverage = process.env.SRN_COVERAGE
const collectCoverage =
  forcedCoverage === '1' ? true : forcedCoverage === '0' ? false : !hasTestFilter(process.argv.slice(2))

module.exports = {
  collectCoverage,
  collectCoverageFrom: [
    'src/javascripts/Services/SyncTransport/**/*.{ts,tsx}',
    'src/javascripts/Components/SuperEditor/Collaboration/**/*.{ts,tsx}',
  ],
  coverageReporters: ['text', 'text-summary'],
  // Directory floors, MEASURED on the full suite (486 suites / 5 349 tests) and
  // recorded in `.orchestration/logs/t92/t92-w3-e2.md`, each minus 2 pp.
  // There is deliberately NO `global` entry: the denominator above is only
  // these two directories, so a global floor would say the same thing twice
  // and would move whenever the split between them moved.
  coverageThreshold: {
    // measured 72.28 / 70.53 / 82.48 / 72.46
    './src/javascripts/Services/SyncTransport/': {
      statements: 70.28,
      branches: 68.53,
      functions: 80.48,
      lines: 70.46,
    },
    // measured 82.79 / 77.43 / 88.85 / 82.86
    './src/javascripts/Components/SuperEditor/Collaboration/': {
      statements: 80.79,
      branches: 75.43,
      functions: 86.85,
      lines: 80.86,
    },
  },
  restoreMocks: true,
  clearMocks: true,
  resetMocks: true,
  moduleNameMapper: {
    ...pathsToModuleNameMapper(pathsFromTsconfig, {
      prefix: '<rootDir>',
    }),
    // PDF.js 6 is ESM-only and uses `import.meta` in its prebuilt runtime. The
    // production webpack build consumes that module directly; CommonJS Jest
    // suites use explicit fail-closed shims so importing PdfPreview does not
    // crash unrelated suites before their tests can run.
    '^pdfjs-dist/legacy/build/pdf\\.mjs$': '<rootDir>/src/javascripts/__mocks__/pdfjsRuntimeMock.ts',
    '^pdfjs-dist/legacy/build/pdf\\.worker\\.min\\.mjs$': '<rootDir>/src/javascripts/__mocks__/pdfjsWorkerMock.ts',
    // Webpack inline-loader specifiers (`!css-loader?{…}!sass-loader?{…}!….scss`)
    // import raw stylesheet TEXT, which product code calls `.toString()` on. They
    // must be matched BEFORE the generic rule below (first match wins): the generic
    // rule sends them to identity-obj-proxy, whose `.toString` is the string
    // "toString" rather than a function.
    '^!.*!.*\\.(css|less|scss|sass)$': '<rootDir>/src/javascripts/__mocks__/rawCssMock.js',
    '\\.(css|less|scss|sass)$': 'identity-obj-proxy',
    // Deep imports of pure toast modules resolve to real sources (unit-testable);
    // the package root stays proxied since its index pulls in React components.
    '^@standardnotes/toast/src/(.*)$': '<rootDir>/../toast/src/$1',
    '@standardnotes/toast': 'identity-obj-proxy',
    '@standardnotes/styles': 'identity-obj-proxy',
    '@simplewebauthn/browser': 'identity-obj-proxy',
    '^@lexical/headless$': '<rootDir>/../../node_modules/@lexical/headless/dist/LexicalHeadless.js',
  },
  globals: {
    __WEB_VERSION__: '1.0.0',
  },
  transform: {
    '^.+\\.(ts|tsx|js|jsx)?$': 'ts-jest',
    '\\.svg$': 'svg-jest',
  },
  transformIgnorePatterns: ['node_modules/(?!(react-error-boundary)/)'],
  testEnvironment: 'jsdom',
}
