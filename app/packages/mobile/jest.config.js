module.exports = {
  clearMocks: true,
  resetMocks: true,
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': 'babel-jest',
  },
}
