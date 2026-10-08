import 'reflect-metadata'

import { Response } from 'express'
import { Repository } from 'typeorm'

import { AnnotatedHealthCheckController } from './AnnotatedHealthCheckController'
import { Role } from '../../Domain/Role/Role'

/**
 * Standard Red Notes: the multi-container entry point to auth's readiness
 * answer.
 *
 * The composition itself moved to `AuthReadinessEndpoint`, because the bundled
 * home-server serves this same route from a loopback-only internal listener —
 * auth has no HTTP port on that topology, and its annotated controllers are
 * deliberately never mounted there (they declare unprefixed bases such as
 * `/auth`, `/sessions` and `/internal`, which on one shared port would publish
 * auth's internal surface at the public front door).
 *
 * SO WHAT IS LEFT TO TEST HERE is exactly the shell: that the route probes the
 * bindings this container injects — the role repository's manager and the
 * optional cache — and that the status code is the one the report dictates. The
 * readiness VOCABULARY (what a missing cache means, what a failing probe means)
 * is tested once, in `AuthReadinessEndpoint.spec.ts`.
 */
describe('AnnotatedHealthCheckController /readiness', () => {
  let jsonMock: jest.Mock
  let statusMock: jest.Mock

  const response = (): Response => {
    jsonMock = jest.fn()
    statusMock = jest.fn(() => ({ json: jsonMock }))

    return { status: statusMock, json: jsonMock } as unknown as Response
  }

  const status = (): number => statusMock.mock.calls[0][0] as number
  const body = (): { status: string; checks: Record<string, boolean> } =>
    jsonMock.mock.calls[0][0] as { status: string; checks: Record<string, boolean> }

  const roleRepository = (query: () => Promise<unknown>): Repository<Role> =>
    ({ manager: { query } }) as unknown as Repository<Role>

  const controllerWith = (
    query: () => Promise<unknown>,
    redis?: { ping(): Promise<string> },
  ): AnnotatedHealthCheckController =>
    new AnnotatedHealthCheckController(
      roleRepository(query),
      redis,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    )

  it('answers 200 with both checks when the injected dependencies answer', async () => {
    const res = response()

    await controllerWith(async () => [], { ping: async () => 'PONG' }).readiness(res)

    expect(status()).toBe(200)
    expect(body()).toEqual({ status: 'ready', checks: { db: true, redis: true } })
  })

  it('probes the REAL injected role repository manager', async () => {
    const query = jest.fn(async () => [])
    const res = response()

    await controllerWith(query).readiness(res)

    // The connection this service actually holds, not a second handle opened
    // here: the point of the route is that the answer is direct evidence.
    expect(query).toHaveBeenCalledTimes(1)
    expect(query).toHaveBeenCalledWith('SELECT 1')
  })

  it('answers 200 with the cache healthy when CACHE_TYPE=memory binds none', async () => {
    const res = response()

    await controllerWith(async () => []).readiness(res)

    expect(status()).toBe(200)
    expect(body()).toEqual({ status: 'ready', checks: { db: true, redis: true } })
  })

  it('answers 503 when a dependency is down, so the orchestrator stops routing here', async () => {
    const res = response()

    await controllerWith(async () => {
      throw new Error('connect ECONNREFUSED 10.1.2.3:3306')
    }).readiness(res)

    expect(status()).toBe(503)
    expect(body()).toEqual({ status: 'unavailable', checks: { db: false, redis: true } })
    expect(JSON.stringify(body())).not.toContain('10.1.2.3')
  })

  it('answers 503 when the injected cache is down, though the database answers', async () => {
    const res = response()

    await controllerWith(async () => [], {
      ping: async () => {
        throw new Error('NOAUTH Authentication required')
      },
    }).readiness(res)

    expect(status()).toBe(503)
    expect(body()).toEqual({ status: 'unavailable', checks: { db: true, redis: false } })
  })

  it('serves the report as the whole body, adding nothing of its own', async () => {
    const res = response()

    await controllerWith(async () => []).readiness(res)

    // The gateway reads `status` and `checks` off this body and the home-server's
    // internal listener serves the identical object. A field added only here
    // would exist on one topology and not the other.
    expect(Object.keys(body())).toEqual(['status', 'checks'])
  })
})
