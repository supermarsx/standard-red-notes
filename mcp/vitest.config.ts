import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      // Whole-source denominator: instrument every production module, not only
      // the ones a test imports. No thresholds yet — measurement first.
      all: true,
      include: ["src/**/*.ts"],
      // src/e2e/** is 7,856 LOC of live-stack scripts driven by run-e2e.mjs
      // (real docker stack + real E2EE account). Not unit-testable; excluding
      // them keeps the denominator honest rather than permanently red.
      exclude: ["src/e2e/**", "src/**/*.d.ts"],
      reporter: ["text", "json-summary", "lcov"],
      reportsDirectory: "coverage",
    },
  },
});
