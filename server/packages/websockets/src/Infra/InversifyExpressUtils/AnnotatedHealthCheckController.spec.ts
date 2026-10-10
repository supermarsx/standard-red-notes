import 'reflect-metadata'

import { AnnotatedHealthCheckController } from './AnnotatedHealthCheckController'

/**
 * Standard Red Notes: this spec exists because the file it covers had NO test
 * at all and was outside this package's coverage denominator, behind a flat
 * `'/InversifyExpressUtils/'` entry in `coveragePathIgnorePatterns`.
 *
 * This controller is LIVENESS ONLY — unlike auth, files, revisions and
 * syncing-server, this package exposes no `/healthcheck/readiness`. That is
 * recorded as a finding alongside this change, not fixed here. What the spec
 * pins is the property that makes a liveness probe safe to poll: it is
 * dependency-free. The distinction matters because an orchestrator restarts a
 * container on a failed LIVENESS probe but merely stops routing to it on a
 * failed READINESS probe, so a liveness endpoint that reached for the database
 * would turn a DB blip into a restart loop across every websockets replica.
 */
describe('AnnotatedHealthCheckController', () => {
  it('answers OK for liveness', async () => {
    expect(await new AnnotatedHealthCheckController().get()).toEqual('OK')
  })

  // A structural assertion, deliberately: it is the only way to pin
  // "dependency-free" from a unit test. `Function.length` counts the declared
  // constructor parameters, so injecting a repository, a Redis client or a
  // logger into this controller fails here. Constructing with no arguments at
  // all — which the test above does — is the behavioural half of the same
  // claim.
  it('takes no injected dependencies, so a sick dependency cannot fail liveness', () => {
    expect(AnnotatedHealthCheckController.length).toEqual(0)
  })
})
