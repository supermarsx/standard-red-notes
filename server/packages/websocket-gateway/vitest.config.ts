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
        // Per-file floors for the three realtime modules the t90 review found
        // carrying the most untested branches. A global 90 lets one module rot
        // while the package average hides it: `inviteEventOutbox.ts` sat at
        // 77.08 % statements with the global reading 92.7 %.
        //
        // Every number is MEASURED minus 1 pp, recorded in
        // `.orchestration/logs/t92/t92-w3-e2.md`.
        //
        // These keys are picomatch globs matched against the path RELATIVE to
        // this config's directory (vitest `resolveThresholds`). Unlike jest,
        // vitest keeps glob-matched files in the GLOBAL denominator too — "the
        // global threshold is for all files, even if they are included by glob
        // patterns" — so the 90 above still judges these three as well; the
        // entries below only add a stricter, per-module floor.
        //
        // Raise a floor when you raise the coverage; never lower one to make a
        // run go green.
        'src/gateway.ts': {
          // measured 91.46 / 90.76 / 85.18 / 91.89
          statements: 90.46,
          branches: 89.76,
          functions: 84.18,
          lines: 90.89,
        },
        'src/syncCommandHandler.ts': {
          // measured 87.51 / 84.47 / 90.19 / 87.85
          statements: 86.51,
          branches: 83.47,
          functions: 89.19,
          lines: 86.85,
        },
        'src/inviteEventOutbox.ts': {
          // measured 77.08 / 84.44 / 93.75 / 76.08
          statements: 76.08,
          branches: 83.44,
          functions: 92.75,
          lines: 75.08,
        },
      },
    },
  },
})
