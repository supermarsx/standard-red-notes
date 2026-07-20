// eslint-disable-next-line @typescript-eslint/no-var-requires
const base = require('../../common.jest.json')

module.exports = {
  ...base,
  // This package is browser-only: it drives <input type="file">, anchor downloads and the
  // File System Access API, all of which need a DOM.
  testEnvironment: 'jsdom',
  coveragePathIgnorePatterns: ['/example/'],
  // *.d.ts files are ambient declarations with no runtime code.
  collectCoverageFrom: ['src/**/*.{ts,tsx}', '!**/index.ts', '!**/*.d.ts'],
}
