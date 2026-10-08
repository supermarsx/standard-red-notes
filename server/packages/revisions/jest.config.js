// eslint-disable-next-line @typescript-eslint/no-var-requires
const base = require('../../jest.config')

module.exports = {
  ...base,
  // This list used to read `['/Bootstrap/', '/Controller/',
  // 'HealthCheckController', '/Infra/', '/Mapping/']`. Three problems with it,
  // all of the flattering-denominator kind:
  //
  //  * `'/Controller/'` matched ZERO files — there is no `src/Controller/` in
  //    this package — so it was inert, while standing ready to exclude any
  //    such directory that ever appeared.
  //  * `'HealthCheckController'` was fully redundant with the flat
  //    `'/Infra/'`: the one file it matched lives under it. It read like a
  //    second, independent reason to exclude a readiness controller when it
  //    was the same one twice.
  //  * `'/Infra/'` was flat, so it took the whole of Infra out — including
  //    `AnnotatedHealthCheckController.ts` (63 lines racing a DB `SELECT 1`
  //    against a 2 s deadline and answering 503, an orchestrator-facing
  //    decision) and `Middleware/ApiGatewayAuthMiddleware.ts` (the one thing
  //    between an unauthenticated request and every revisions route, and what
  //    decides `readOnlyAccess`). The first had a spec that ran on every suite
  //    with no floor able to see it; the second had no spec at all, and one
  //    landed with this change.
  //
  // The Infra subdirectories are now enumerated POSITIVELY rather than
  // excluded as a block, so a new one defaults to being gated instead of
  // defaulting to invisible. What stays out and why:
  coveragePathIgnorePatterns: [
    '/Bootstrap/',
    // Persistence and object-store adapters: exercised by standing the store
    // up, not by unit coverage.
    '/Infra/FS/',
    '/Infra/S3/',
    '/Infra/TypeORM/',
    // The inversify route shells. `AnnotatedRevisionsController.ts` and
    // `Base/BaseRevisionsController.ts` are decorator-and-delegate wiring
    // whose own specs measure 73/100/0/71 and 41/40/29/38 — a real gap, named
    // here rather than hidden: they are the same shape as auth's
    // `/Infra/InversifyExpressUtils/` and excluded on the same grounds.
    // `AnnotatedHealthCheckController.ts` is deliberately NOT matched by this
    // pattern.
    '/Infra/InversifyExpress/AnnotatedRevisionsController',
    '/Infra/InversifyExpress/Base/',
    '/Mapping/',
  ],
  // Instrument every non-ignored source file, not only the ones a spec happens to import.
  // Without this the package reported 100/100/100/100 while really measuring 83.73
  // statements — five domain event handlers were absent from the denominator entirely.
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.spec.ts'],
  coverageThreshold: {
    ...base.coverageThreshold,
    // The two files this change brought into the denominator, pinned at their
    // MEASURED coverage. The package `global` above is failable on its own
    // here (a ~600-statement denominator at a 99 floor), so these entries are
    // not propping it up — they exist because a `global` group cannot notice a
    // file LEAVING the denominator: jest prints `0 | 0 | 0 | 0` and exits 0
    // when nothing is instrumented. A path-keyed entry fails with `Jest:
    // Coverage data for ./<path> was not found.` instead, so putting either
    // file back behind an ignore pattern breaks the gate rather than quietly
    // reverting this change.
    //
    // `branches` is 87.5 on the readiness controller and that is its ceiling:
    // the eighth branch is the `if (timer)` guard in `withTimeout`, whose
    // false arm is UNREACHABLE — `Promise.race` evaluates its array
    // synchronously, so the executor that assigns `timer` has always run by
    // the time `finally` reads it.
    './src/Infra/InversifyExpress/AnnotatedHealthCheckController.ts': {
      statements: 100,
      branches: 87.5,
      functions: 100,
      lines: 100,
    },
    './src/Infra/InversifyExpress/Middleware/ApiGatewayAuthMiddleware.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
  },
}
