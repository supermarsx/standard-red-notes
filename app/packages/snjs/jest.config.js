// eslint-disable-next-line @typescript-eslint/no-var-requires
const base = require('../../common.jest.json')

module.exports = {
  ...base,
  moduleNameMapper: {
    '@Lib/(.*)': '<rootDir>/lib/$1',
    '@Services/(.*)': '<rootDir>/lib/Services/$1',
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      { tsconfig: './lib/tsconfig.json', isolatedModules: true, babelConfig: 'babel.config.js' },
    ],
  },
  clearMocks: true,
  collectCoverageFrom: ['lib/**/{!(index),}.ts'],
  coverageDirectory: 'coverage',
  coverageReporters: ['json', 'text', 'html'],
  resetMocks: true,
  resetModules: true,
  roots: ['<rootDir>/lib'],
  setupFiles: ['<rootDir>/jest-global.ts'],
  setupFilesAfterEnv: [],
  // RATCHET, NOT A TARGET. See the longer note in `packages/encryption/jest.config.js`.
  //
  // A record of where this package measured on 2026-09-30, minus about two points, so coverage
  // cannot silently fall. Not an opinion about where it should be, and not something to raise
  // because it looks low — raise it only after real tests have moved the measurement past it.
  //
  // The previous 13 br / 22 fn / 27 li / 27 st was never evaluated (the `test` script passed no
  // `--coverage`) and was also far below reality, so enabling it unchanged would have produced a
  // gate that could not fire — the same defect in a second form. Measured 43.48 st / 41.31 br /
  // 34.46 fn / 43.24 li over 48 suites / 491 tests.
  coverageThreshold: {
    global: {
      branches: 39,
      functions: 32,
      lines: 41,
      statements: 41,
    },
  },
}
