module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testRegex: '(/__tests__/.*|(\\.|/)(test|spec))\\.ts$',
  testTimeout: 20000,
  coverageThreshold: {
    global: {
      branches: 99,
      functions: 100,
      lines: 99,
      statements: 99,
    },
  },
};
