module.exports = {
  testEnvironment: 'node',
  testRegex: '(/__tests__/.*|(\\.|/)(test|spec))\\.ts$',
  testTimeout: 20000,
  transform: {
    '^.+\\.[cm]?[jt]sx?$': [
      '@swc/jest',
      {
        jsc: {
          parser: {
            syntax: 'typescript',
            decorators: true,
          },
          transform: {
            legacyDecorator: true,
            decoratorMetadata: true,
          },
          target: 'es2022',
          keepClassNames: true,
        },
        module: {
          type: 'commonjs',
        },
        sourceMaps: 'inline',
      },
    ],
  },
  transformIgnorePatterns: ['/node_modules/(?!(?:inversify|@inversifyjs|uuid)(?:/|$))'],
  coverageThreshold: {
    global: {
      branches: 90,
      functions: 100,
      lines: 99,
      statements: 99,
    },
  },
};
