// eslint-disable-next-line @typescript-eslint/no-var-requires
const base = require('../../jest.config')

module.exports = {
  ...base,
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.spec.ts'],
  // `'/InversifyExpressUtils/'` used to sit in this list and it took the whole
  // directory out of the denominator — three files, NONE of which had a test:
  //
  //  * `Middleware/ApiGatewayAuthMiddleware.ts` (60 lines) is the only thing
  //    between an unauthenticated request and every `/sockets` route, and it
  //    is what decides `readOnlyAccess`.
  //  * `AnnotatedWebSocketsController.ts` (61 lines) mints the connection
  //    token for whatever identity is on `response.locals` and maps a failed
  //    use case to 400.
  //  * `AnnotatedHealthCheckController.ts` is the liveness endpoint.
  //
  // With the directory excluded this package printed `All files 100 | 100 |
  // 100 | 100` and the inherited 99/99/100/90 floor passed over a denominator
  // that did not contain a single one of them. Specs for all three landed with
  // this change — the tests first, then the denominator — so the pattern is
  // gone rather than narrowed.
  //
  // `/Bootstrap/` stays: `Container.ts`, `DataSource.ts`, `Types.ts`, `Env.ts`
  // and `MigrationsDataSource.ts` are composition-root wiring, exercised by
  // standing the service up rather than by unit coverage. That is the same
  // exclusion every package in this repo carries.
  coveragePathIgnorePatterns: ['/Bootstrap/'],
  setupFilesAfterEnv: ['./test-setup.ts'],
}
