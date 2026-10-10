// eslint-disable-next-line @typescript-eslint/no-var-requires
const base = require('../../jest.config')

module.exports = {
  ...base,
  // Added with this change. Without it jest instruments only the files some
  // test happens to IMPORT, so an entirely untested module is counted as
  // neither covered nor uncovered — it is absent from the denominator rather
  // than scored zero. This package printed `All files 100 | 100 | 100 | 100`
  // against the inherited 99/99/100/90 floor over a denominator of 10 files,
  // where the non-ignored source is 20.
  //
  // Measured honestly: closing this hole changes NO number today. Of the ten
  // files it adds, eight are type-only (`JobRepositoryInterface.ts`,
  // `UseCaseInterface.ts`, the `*DTO.ts`/`*Response.ts` pairs) and emit nothing
  // to instrument, and the remaining two — `Domain/Job/Job.ts` and
  // `Domain/Predicate/Predicate.ts` — each carry a whole-file
  // `/* istanbul ignore file */` pragma IN THE SOURCE, which keeps them out of
  // the denominator whatever this config says. That pragma is defensible for a
  // pair of TypeORM entity declarations whose only statements are decorator
  // calls, but it is worth knowing it is there: it is an exclusion that no
  // sweep of coverage CONFIGURATION can see.
  //
  // The value of this entry is therefore structural rather than immediate: a
  // new module under `src/Domain/` is in the denominator the day it lands
  // rather than the day somebody remembers this file.
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.spec.ts'],
  // `'/Infra/'` used to be flat here. Today that is the same thing as
  // `'/Infra/MySQL/'` — MySQL is the only subdirectory this package has — so
  // the flat form was inert, but it stood ready to exclude any Infra
  // subdirectory that ever appeared, which is how the much larger holes in
  // auth, revisions, files and syncing-server started. Named positively so a
  // new one defaults to being gated.
  //
  // What stays out and why: `MySQLJobRepository.ts` (47 lines) and
  // `MySQLPredicateRepository.ts` (28 lines) are thin TypeORM query-builder
  // wrappers — `save`, two `createQueryBuilder(...).getMany()` reads and one
  // `update().set().where().execute()`. They do have specs, and those specs
  // assert on a mocked query-builder call chain rather than on any behaviour,
  // so bringing them into the denominator would buy a number and not a gate.
  // Exercised by standing the store up, the same grounds auth, revisions and
  // syncing-server exclude their persistence adapters on. Named here rather
  // than hidden behind a directory wildcard.
  coveragePathIgnorePatterns: ['/Bootstrap/', '/Infra/MySQL/', '/Domain/Email/', '/Domain/Event/'],
}
