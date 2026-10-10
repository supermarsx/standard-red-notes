// eslint-disable-next-line @typescript-eslint/no-var-requires
const base = require('../../jest.config')

module.exports = {
  ...base,
  // Without this, jest only instruments the files a test happens to import, so untested
  // files are absent from the denominator rather than counted as uncovered. The package
  // reported 100% while its mappers and event handlers were entirely unmeasured.
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.spec.ts'],
  // This list used to read `['/Bootstrap/', 'HealthCheckController', '/Infra/',
  // '/Domain/Email/']`, with no comment explaining any of it. Two defects of
  // the flattering-denominator kind, both now closed:
  //
  //  * `'HealthCheckController'` was a bare substring and fully REDUNDANT with
  //    the flat `'/Infra/'` below it — the one file it matched,
  //    `src/Infra/InversifyExpressUtils/AnnotatedHealthCheckController.ts`,
  //    lives under it. It read like a second, independent reason to exclude a
  //    readiness controller when it was the same one twice. That file is the
  //    `/healthcheck/readiness` answer for the syncing service: the thing an
  //    orchestrator reads to decide whether to keep routing sync traffic here.
  //    It had NO spec at all. One landed with this change (13 tests), and the
  //    file is pinned below.
  //  * `'/Infra/'` was flat, so it took the whole of Infra out — 43 files, 36
  //    of which are imported by a spec that RUNS on every suite with no floor
  //    able to see it. Among them `Middleware/InversifyExpressAuthMiddleware.ts`
  //    (the only thing between an unauthenticated request and every syncing
  //    route, and what decides `readOnlyAccess`, the MCP read-only scope and
  //    the shadow-ban flag) and `notFoundFallback.ts` (the post-build JSON-404,
  //    whose predecessor was INERT under Express 5 — the empty-base
  //    double-slash defect). Both had specs and no floor.
  //
  // The Infra subdirectories are now excluded NEGATIVELY rather than as a
  // block, so a new file under `InversifyExpressUtils/` defaults to being gated
  // instead of defaulting to invisible. What stays out and why:
  //
  //  * `'/Infra/(?!InversifyExpressUtils/)'` — `TypeORM/`, `S3/`, `FS/`,
  //    `WebDAV/`, `Redis/`, `Metrics/`, `Dummy/` and `gRPC/`: persistence,
  //    object-store and transport adapters, exercised by standing the store or
  //    the server up rather than by unit coverage. This is the same exclusion
  //    auth and revisions carry, on the same grounds.
  //  * `'/Infra/InversifyExpressUtils/Annotated(?!HealthCheckController)'` and
  //    `'/Infra/InversifyExpressUtils/Base/'` — the inversify route shells.
  //    A REAL remaining gap, named here rather than hidden: `Base/` holds
  //    `BaseItemsController.ts` (508 lines, 3 specs) and
  //    `BaseSharedVaultInvitesController.ts` (347 lines, 2 specs), which are
  //    more than decorator-and-delegate wiring. They are left out of this
  //    change only because another agent is editing them concurrently; bringing
  //    them in is a separate change with its own measurement. The
  //    `Annotated*Controller` files are genuine wiring and have no specs.
  //
  // `/Bootstrap/` and `/Domain/Email/` are unchanged: composition-root wiring
  // and HTML e-mail templates respectively.
  coveragePathIgnorePatterns: [
    '/Bootstrap/',
    '/Infra/(?!InversifyExpressUtils/)',
    '/Infra/InversifyExpressUtils/Annotated(?!HealthCheckController)',
    '/Infra/InversifyExpressUtils/Base/',
    '/Domain/Email/',
  ],
  setupFilesAfterEnv: ['./test-setup.ts'],
  coverageThreshold: {
    ...base.coverageThreshold,
    // The three files this change brought into the denominator, pinned at their
    // MEASURED coverage. Path-keyed rather than left to the package `global`
    // for the reason a `global` group cannot cover one file: a `global` group
    // CANNOT NOTICE A FILE LEAVING the denominator — jest prints `0 | 0 | 0 |
    // 0` and exits 0 when nothing is instrumented. A path-keyed entry fails
    // loudly instead (`Jest: Coverage data for ./<path> was not found.`), so
    // putting any of these back behind an ignore pattern, or renaming one out
    // from under its spec, breaks the gate rather than quietly reverting this
    // change.
    //
    // Jest subtracts a path-keyed file from the `global` group, so none of
    // these three flatters the package average either way.
    //
    // `branches` is 90 on the readiness controller rather than 100, and that is
    // the measured ceiling, not a concession: the tenth branch is the
    // `if (timer)` guard in this module's private `withTimeout` (line 65),
    // whose false arm is UNREACHABLE — `Promise.race` evaluates its array
    // synchronously, so the executor that assigns `timer` has always run by the
    // time `finally` reads it. Pinned exactly at 90, so losing any OTHER branch
    // still fails.
    './src/Infra/InversifyExpressUtils/AnnotatedHealthCheckController.ts': {
      statements: 100,
      branches: 90,
      functions: 100,
      lines: 100,
    },
    './src/Infra/InversifyExpressUtils/Middleware/InversifyExpressAuthMiddleware.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    './src/Infra/InversifyExpressUtils/notFoundFallback.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
  },
}
