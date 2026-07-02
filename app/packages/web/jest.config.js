const pathsToModuleNameMapper = require('ts-jest').pathsToModuleNameMapper
const tsConfig = require('./tsconfig.json')

const pathsFromTsconfig = tsConfig.compilerOptions.paths

module.exports = {
  restoreMocks: true,
  clearMocks: true,
  resetMocks: true,
  moduleNameMapper: {
    ...pathsToModuleNameMapper(pathsFromTsconfig, {
      prefix: '<rootDir>',
    }),
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
