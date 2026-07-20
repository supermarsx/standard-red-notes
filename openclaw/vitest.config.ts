import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      // Whole-source denominator: instrument every shipped module, not only the
      // ones a test happens to import.
      all: true,
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts'],
      reporter: ['text', 'json-summary', 'lcov'],
      reportsDirectory: 'coverage',
      // Collect on every `vitest run`, not only when --coverage is passed.
      // The CI path is `yarn check` -> test:openclaw -> test:unit -> bare
      // `vitest run`; without this the thresholds below would be DECORATIVE,
      // since vitest only evaluates them when coverage is actually collected.
      enabled: true,
      // Achieved at the time this gate was set (271 tests, 19 files):
      //   lines 96.50 | statements 96.10 | functions 93.10 | branches 94.09
      // Margin over the gate: 6.5 / 6.1 / 3.1 / 4.09 pp. Functions is the
      // tightest. The remaining gap is dominated by src/index.ts, which is
      // entirely uncovered (9 branches) because it has no exports and ends in a
      // top-level main().then(process.exit) -- it needs an entry-point seam
      // before it can be tested at all.
      thresholds: {
        lines: 90,
        statements: 90,
        functions: 90,
        branches: 90,
      },
    },
  },
})
