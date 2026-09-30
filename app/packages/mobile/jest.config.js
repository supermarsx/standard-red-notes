module.exports = {
  clearMocks: true,
  resetMocks: true,
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': 'babel-jest',
  },
  // Without this the denominator is only the files some test happens to import, so a source file
  // with no test at all is counted as neither covered nor uncovered and the floors below would
  // measure a subset. Naming the sources explicitly makes the denominator the whole of src, which
  // moves the measurement from 32.30 to 22.45 statements — the 10-point difference is 171
  // statements in files no test loads.
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.test.ts'],
  // RATCHET, NOT A TARGET. See the longer note in `packages/encryption/jest.config.js`.
  //
  // A record of where this package measured on 2026-09-30 against the full-src denominator above,
  // minus about two points, so coverage cannot silently fall. Not an opinion about where it should
  // be, and emphatically not something to raise because it looks low — raise it only after real
  // tests have moved the measurement past it.
  //
  // This package had no `coverageThreshold` of any kind before, and its `test` script passed no
  // `--coverage`. Measured 22.45 st / 24.06 br / 22.58 fn / 22.95 li over 7 suites / 29 tests.
  coverageThreshold: {
    global: {
      statements: 20,
      branches: 22,
      functions: 20,
      lines: 20,
    },
  },
}
