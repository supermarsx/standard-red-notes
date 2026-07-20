import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      // Instrument every source file, not only the ones a test imports, so an
      // untested module cannot vanish from the denominator.
      all: true,
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
