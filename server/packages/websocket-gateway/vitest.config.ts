import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      // `include` is the whole denominator: vitest 4 instruments every matching
      // source file, not only the ones a test imports, so an untested module
      // cannot vanish from the coverage report. (v3's `all` flag is gone.)
      include: ['src/**/*.ts'],
      reporter: ['text', 'text-summary'],
      thresholds: {
        statements: 90,
        branches: 90,
        functions: 90,
        lines: 90,
      },
    },
  },
})
