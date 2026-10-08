import 'reflect-metadata'

import { Request, Response } from 'express'
import { RoleName } from '@standardnotes/domain-core'

import { AdminController, ReadinessFetchLike, ServiceStatusEntry } from './AdminController'
import { ServiceProxyInterface } from '../../Service/Proxy/ServiceProxyInterface'
import { EndpointResolverInterface } from '../../Service/Resolver/EndpointResolverInterface'

jest.mock('../../Service/Assistant/providers/factory', () => ({
  configuredProviders: jest.fn().mockReturnValue([]),
}))

/**
 * Standard Red Notes: `probeDepth` on every `services` entry of
 * `GET /v1/admin/server-status`.
 *
 * WHAT IT DELETES. `status: 'ok'` carried two different claims and nothing
 * published which one it was. A service whose READINESS route answered 200 has
 * reported that its own dependencies are up; a service that only answered the
 * plain LIVENESS route has reported that a process is listening and nothing
 * more. The second is a real deployment state — a sibling whose image predates
 * the readiness route 404s there while being perfectly healthy — and the pane
 * rendered both as the same green. The distinction existed, but only inside the
 * free-form `detail` string, which the pane deliberately refuses to read
 * because free-form server text is exactly where a probe failure puts a host
 * and a port.
 *
 * SO THE DEPTH IS DERIVED FROM WHICH ROUTE WAS CALLED, and `detail` is never
 * consulted. The tests below drive each arm through the real probe and assert
 * both the depth and which URLs were fetched, because "it says liveness" and
 * "it asked the liveness route" are different claims and only the second one
 * means anything.
 *
 * THE SECRECY HALF is asserted on WHAT IS EMITTED: every key of every entry must
 * be named in a declared contract and every value must satisfy its declared
 * closed set or bound. An unnamed key FAILS — that is the arm a denylist cannot
 * have, because it catches a field added later with no sentinel planted in it,
 * and it catches a value whose shape nobody anticipated.
 */
describe('AdminController server-status probe depth', () => {
  let jsonMock: jest.Mock
  let statusMock: jest.Mock
  let realFetch: typeof globalThis.fetch

  type ProbeTarget = {
    probeServiceReadiness: (name: string, url?: string, fetchFn?: ReadinessFetchLike) => Promise<ServiceStatusEntry>
  }

  const SINGLE_CONTAINER_PROBE_URLS = {
    'syncing-server': 'http://localhost:3101',
    auth: 'http://localhost:3103',
    files: 'http://localhost:3104',
    revisions: 'http://localhost:3105',
  }

  const makeController = (serviceProbeUrls?: Record<string, string>): AdminController =>
    new AdminController(
      {} as ServiceProxyInterface,
      {} as EndpointResolverInterface,
      undefined,
      undefined,
      undefined,
      undefined,
      '',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      serviceProbeUrls,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    )

  const responseWith = (roles: Array<{ name: string }>): Response => {
    jsonMock = jest.fn()
    statusMock = jest.fn(() => ({ json: jsonMock }))

    return {
      locals: { user: { uuid: 'admin-1' }, roles },
      setHeader: jest.fn(),
      status: statusMock,
      json: jsonMock,
    } as unknown as Response
  }

  const adminResponse = (): Response => responseWith([{ name: RoleName.NAMES.AdminUser }])

  const services = (): ServiceStatusEntry[] =>
    (jsonMock.mock.calls[0][0] as { services: ServiceStatusEntry[] }).services

  const byName = (): Record<string, ServiceStatusEntry> =>
    Object.fromEntries(services().map((service) => [service.name, service]))

  /** Probe one service through the real method, with a scripted pair of answers. */
  const probe = async (
    answers: Array<{ status: number } | { throws: true }>,
  ): Promise<{ entry: ServiceStatusEntry; urls: string[] }> => {
    const urls: string[] = []
    let index = 0
    const fetchFn = jest.fn(async (url: string) => {
      urls.push(url)
      const answer = answers[index]
      index += 1
      if (answer === undefined || 'throws' in answer) {
        throw new Error('connect ECONNREFUSED 10.0.3.14:3105')
      }

      return { status: answer.status, json: async () => ({}) }
    })

    const entry = await (makeController() as unknown as ProbeTarget).probeServiceReadiness(
      'revisions',
      'http://localhost:3105',
      fetchFn as unknown as ReadinessFetchLike,
    )

    return { entry, urls }
  }

  beforeEach(() => {
    realFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  /* ------------------------------------------------------------------------ */
  /* Which route backed the status                                            */
  /* ------------------------------------------------------------------------ */

  it('reports `readiness` for a service whose readiness route answered 200, having asked only that route', async () => {
    const { entry, urls } = await probe([{ status: 200 }])

    expect(entry).toMatchObject({ status: 'ok', probeDepth: 'readiness' })
    expect(urls).toEqual(['http://localhost:3105/healthcheck/readiness'])
  })

  it('reports `readiness` for a 503, because a 503 IS that route answering', async () => {
    const { entry, urls } = await probe([{ status: 503 }])

    // The depth is about which route spoke, not about whether the news was
    // good: a 503 is the readiness route reporting its own verdict, and the
    // `degraded` beside it is as deep a reading as this endpoint can take.
    expect(entry).toMatchObject({ status: 'degraded', probeDepth: 'readiness' })
    expect(urls).toEqual(['http://localhost:3105/healthcheck/readiness'])
  })

  it('reports `liveness` for the service that 404s on readiness and answers the plain route', async () => {
    const { entry, urls } = await probe([{ status: 404 }, { status: 200 }])

    // THE ENTRY THIS FIELD EXISTS FOR. The same `ok` a fully-ready service
    // reports, on a service whose dependencies were never asked about.
    expect(entry).toMatchObject({ status: 'ok', probeDepth: 'liveness' })
    expect(urls).toEqual(['http://localhost:3105/healthcheck/readiness', 'http://localhost:3105/healthcheck'])
  })

  it('reports `unknown` when both routes were asked and neither confirmed the service', async () => {
    const { entry, urls } = await probe([{ status: 404 }, { status: 500 }])

    expect(entry).toMatchObject({ status: 'down', probeDepth: 'unknown' })
    expect(urls).toHaveLength(2)
  })

  it('reports `unknown` for a status neither route is supposed to give', async () => {
    // A proxy answering in the service's place, or a half-started process.
    // Something answered; nothing was established.
    for (const status of [401, 500, 502]) {
      const { entry } = await probe([{ status }])
      expect(entry).toMatchObject({ status: 'down', probeDepth: 'unknown' })
    }
  })

  it('reports `unknown` for a dial that did not complete, and reads no word of the failure', async () => {
    const { entry } = await probe([{ throws: true }])

    expect(entry).toMatchObject({ reachable: false, status: 'down', probeDepth: 'unknown' })
    // The rejection is never inspected: that is where a driver puts a host and
    // a port. `detail` stays the build's own constant.
    expect(JSON.stringify(entry)).not.toContain('10.0.3.14')
  })

  it('reports `unknown` for a service with no URL to probe, rather than omitting the field', async () => {
    const entry = await (makeController() as unknown as ProbeTarget).probeServiceReadiness('files', undefined)

    // Absent has to keep meaning "a server too old to publish a depth", so a
    // build that HAS the field says `unknown` even where it probed nothing.
    expect(entry).toMatchObject({ status: 'unknown', probeDepth: 'unknown' })
  })

  it('never derives the depth from `detail`, which the pane refuses to read', async () => {
    // A service answering 200 on readiness with a body claiming to be a
    // liveness fallback. The depth comes from the ROUTE, so the claim is
    // ignored — and the inverse too: the 404-then-200 arm above reports
    // `liveness` with no reference to its own `detail` string.
    const fetchFn = jest.fn(async () => ({
      status: 200,
      json: async () => ({ detail: 'liveness only', probeDepth: 'liveness' }),
    }))

    const entry = await (makeController() as unknown as ProbeTarget).probeServiceReadiness(
      'revisions',
      'http://localhost:3105',
      fetchFn as unknown as ReadinessFetchLike,
    )

    expect(entry.probeDepth).toBe('readiness')
    expect(entry.detail).toBeUndefined()
  })

  /* ------------------------------------------------------------------------ */
  /* The whole services array, end to end through the handler                 */
  /* ------------------------------------------------------------------------ */

  it('publishes a depth for EVERY entry, differing between a ready service and a liveness-only one', async () => {
    // One readiness route, one 404-then-liveness sibling, one unreachable, and
    // one with no URL at all — the shape of a real mixed deployment.
    globalThis.fetch = (async (url: string) => {
      if (url === 'http://localhost:3103/healthcheck/readiness') {
        return { status: 200, json: async () => ({ status: 'ready', checks: { db: true, redis: true } }) }
      }
      if (url === 'http://localhost:3101/healthcheck/readiness') {
        return { status: 200, json: async () => ({}) }
      }
      if (url === 'http://localhost:3105/healthcheck/readiness') {
        return { status: 404, json: async () => ({}) }
      }
      if (url === 'http://localhost:3105/healthcheck') {
        return { status: 200, json: async () => ({}) }
      }

      throw new Error('connect ECONNREFUSED 10.0.3.14:3104')
    }) as unknown as typeof globalThis.fetch

    await makeController(SINGLE_CONTAINER_PROBE_URLS).getServerStatus({} as Request, adminResponse())

    const entries = byName()
    expect(entries['auth']).toMatchObject({ status: 'ok', probeDepth: 'readiness' })
    expect(entries['syncing-server']).toMatchObject({ status: 'ok', probeDepth: 'readiness' })
    // Two entries, both `ok`, with DIFFERENT depths. That difference is the
    // whole point of the field: it is the only thing separating them.
    expect(entries['revisions']).toMatchObject({ status: 'ok', probeDepth: 'liveness' })
    expect(entries['syncing-server'].status).toBe(entries['revisions'].status)
    expect(entries['syncing-server'].probeDepth).not.toBe(entries['revisions'].probeDepth)

    expect(entries['files']).toMatchObject({ status: 'down', probeDepth: 'unknown' })
    // The gateway is the process answering this request; its `ok` is
    // self-reported rather than established by any route.
    expect(entries['api-gateway']).toMatchObject({ status: 'ok', probeDepth: 'unknown' })
    expect(entries['websocket-gateway']).toMatchObject({ status: 'unknown', probeDepth: 'unknown' })

    // Not one entry is silent about it, so a reader never has to guess which
    // silence an absent depth is.
    expect(services().every((service) => service.probeDepth !== undefined)).toBe(true)
  })

  it('reports `unknown` for an auth server that could not be reached', async () => {
    globalThis.fetch = (async () => {
      throw new Error('connect ECONNREFUSED 10.0.3.14:3103')
    }) as unknown as typeof globalThis.fetch

    await makeController(SINGLE_CONTAINER_PROBE_URLS).getServerStatus({} as Request, adminResponse())

    expect(byName()['auth']).toMatchObject({ reachable: false, status: 'down', probeDepth: 'unknown' })
  })

  it('reports `readiness` for a degraded auth, whose readiness route answered with failing checks', async () => {
    globalThis.fetch = (async (url: string) => {
      if (url === 'http://localhost:3103/healthcheck/readiness') {
        return { status: 503, json: async () => ({ status: 'unavailable', checks: { db: false, redis: true } }) }
      }

      throw new Error('not under test')
    }) as unknown as typeof globalThis.fetch

    await makeController(SINGLE_CONTAINER_PROBE_URLS).getServerStatus({} as Request, adminResponse())

    expect(byName()['auth']).toMatchObject({ reachable: true, status: 'degraded', probeDepth: 'readiness' })
  })

  /* ------------------------------------------------------------------------ */
  /* The emitted contract                                                     */
  /* ------------------------------------------------------------------------ */

  /**
   * Every key a service entry may carry, and what its value may be. A key
   * emitted that is not named here FAILS.
   *
   * `name` and `detail` are the two STRING members, and they are declared as
   * what they are rather than waved through: `name` must be a member of this
   * build's own closed service list, and `detail` must be one of the build's
   * own constants or the one templated form it has — which is why the pane
   * reads neither of them and this field was added instead.
   */
  const SERVICE_NAMES = ['api-gateway', 'auth', 'syncing-server', 'files', 'revisions', 'websocket-gateway'] as const
  const DETAILS = ['not configured', 'unreachable', 'liveness only', 'readiness reported unavailable'] as const
  const STATUSES = ['ok', 'degraded', 'down', 'unknown'] as const
  const DEPTHS = ['readiness', 'liveness', 'unknown'] as const

  const CONTRACT: Record<
    string,
    | { kind: 'boolean' }
    | { kind: 'closed'; allowed: readonly string[] }
    | { kind: 'bound'; max: number }
    | { kind: 'detail' }
  > = {
    name: { kind: 'closed', allowed: SERVICE_NAMES },
    reachable: { kind: 'boolean' },
    status: { kind: 'closed', allowed: STATUSES },
    detail: { kind: 'detail' },
    responseTimeMs: { kind: 'bound', max: 60_000 },
    probeDepth: { kind: 'closed', allowed: DEPTHS },
  }

  const assertEntries = (): string[] => {
    const checked: string[] = []
    for (const entry of services()) {
      for (const [key, value] of Object.entries(entry as unknown as Record<string, unknown>)) {
        if (value === undefined) {
          continue
        }
        const rule = CONTRACT[key]
        if (rule === undefined) {
          throw new Error(`services[].${key} is emitted but not named in the contract`)
        }
        if (rule.kind === 'boolean') {
          expect(typeof value).toBe('boolean')
        } else if (rule.kind === 'closed') {
          expect(rule.allowed).toContain(value)
        } else if (rule.kind === 'bound') {
          expect(typeof value).toBe('number')
          expect(Number.isInteger(value)).toBe(true)
          expect(value as number).toBeGreaterThanOrEqual(0)
          expect(value as number).toBeLessThanOrEqual(rule.max)
        } else {
          // The one templated member: a constant, or `unexpected status <code>`
          // with a bare three-digit code and nothing else.
          expect(typeof value).toBe('string')
          if (!(DETAILS as readonly string[]).includes(value as string)) {
            expect(value as string).toMatch(/^unexpected status \d{3}$/)
          }
        }
        checked.push(`${String(entry.name)}.${key}`)
      }
    }

    return checked
  }

  it('emits nothing but contract-conformant values from a hostile set of probe answers', async () => {
    // Each answer is a different shape of leak, in a different place a service
    // could put one: a redirect carrying a location, a body that is itself a
    // connection string, a status code outside anything either route gives, and
    // a rejection whose message is an address. None of them may reach an entry,
    // and the array must still be fully populated so the sweep is not passing
    // over an empty payload.
    globalThis.fetch = (async (url: string) => {
      if (url === 'http://localhost:3103/healthcheck/readiness') {
        return {
          status: 200,
          json: async () => ({
            status: 'ready',
            checks: { db: true },
            host: 'db.internal.example:3306',
            dsn: 'mysql://std_notes_user:changeme123@db:3306/standard_notes_db',
          }),
        }
      }
      if (url === 'http://localhost:3101/healthcheck/readiness') {
        return { status: 307, json: async () => ({ location: 'https://admin:hunter2@notes.internal.example:8443' }) }
      }
      if (url === 'http://localhost:3105/healthcheck/readiness') {
        return { status: 404, json: async () => ({}) }
      }
      if (url === 'http://localhost:3105/healthcheck') {
        return { status: 418, json: async () => ({ detail: 'teapot at 10.0.3.14:3105' }) }
      }

      throw new Error('getaddrinfo EAI_AGAIN files.internal.example (10.0.3.14:3104)')
    }) as unknown as typeof globalThis.fetch

    await makeController(SINGLE_CONTAINER_PROBE_URLS).getServerStatus({} as Request, adminResponse())

    const checked = assertEntries()
    // Six services, and every one of them inspected rather than skipped. A
    // flattering denominator is one of the ways a sweep like this comes to
    // prove nothing.
    expect(new Set(checked.map((path) => path.split('.')[0])).size).toBe(6)
    expect(checked.length).toBeGreaterThan(20)

    // Corroborating only, and deliberately second: this is the denylist arm,
    // here to document the shapes rather than to be the boundary.
    const serialized = JSON.stringify(services())
    for (const planted of [
      'hunter2',
      'internal.example',
      'std_notes_user',
      'changeme123',
      'standard_notes_db',
      '10.0.3.14',
      'EAI_AGAIN',
      'teapot',
      '8443',
      '3306',
      'localhost',
    ]) {
      expect(serialized).not.toContain(planted)
    }
  })

  it('never lets a probe failure take the endpoint down', async () => {
    // The deployment this pane exists for is the broken one, so every arm has
    // to degrade to a field value rather than a status code.
    globalThis.fetch = (() => {
      throw new Error('boom')
    }) as unknown as typeof globalThis.fetch

    await makeController(SINGLE_CONTAINER_PROBE_URLS).getServerStatus({} as Request, adminResponse())

    expect(statusMock).not.toHaveBeenCalled()
    expect(assertEntries().length).toBeGreaterThan(20)
    expect(services().every((service) => service.probeDepth === 'unknown')).toBe(true)
  })

  it('stays admin-only, because it now says which claim each green actually is', async () => {
    await makeController(SINGLE_CONTAINER_PROBE_URLS).getServerStatus(
      {} as Request,
      responseWith([{ name: 'CORE_USER' }]),
    )

    expect(statusMock).toHaveBeenCalledWith(403)
  })
})
