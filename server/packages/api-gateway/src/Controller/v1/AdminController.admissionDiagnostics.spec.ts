import 'reflect-metadata'

import { Request, Response } from 'express'
import type { AttachedGateway } from '@standard-red-notes/websocket-gateway'

import { AdminController } from './AdminController'
import { ServiceProxyInterface } from '../../Service/Proxy/ServiceProxyInterface'
import { EndpointResolverInterface } from '../../Service/Resolver/EndpointResolverInterface'
import { syncGateDiagnostics } from '../../Service/Sync/SyncGateDiagnostics'
import { syncWebSocketAccessService } from '../../Service/Sync/SyncWebSocketAccessService'
import { webSocketGatewayAccessService } from '../../Service/Sync/SyncWebSocketRuntime'
import { deploymentDiagnostics } from '../../Service/Diagnostics/DeploymentDiagnostics'
import {
  MAX_REPORTED_ADMISSION_EVENTS,
  MAX_REPORTED_ADVERTISABLE_OPERATIONS,
  MAX_REPORTED_LIVE_SOCKETS,
  MAX_REPORTED_ORIGIN_RULES,
} from '../../Service/Diagnostics/AdmissionDiagnostics'

jest.mock('../../Service/Assistant/providers/factory', () => ({
  configuredProviders: jest.fn().mockReturnValue([]),
}))

/**
 * Standard Red Notes: the GATEWAY ADMISSION AND TRAFFIC block of
 * `GET /v1/admin/sync-diagnostics`.
 *
 * The panel's block is ALL OR NOTHING: `admissionReported()` renders all ten
 * rows the moment one member is defined, so publishing three of them would
 * render seven rows as though they had been measured and found empty. Both
 * sides of that are asserted here — nothing attached means no block at all,
 * and an attached gateway means every member — because only one of the two is
 * a bug an operator would ever see, and it is the one a test is least likely
 * to cover.
 */
describe('AdminController admission diagnostics', () => {
  let jsonMock: jest.Mock
  let statusMock: jest.Mock

  const makeController = () => new AdminController({} as ServiceProxyInterface, {} as EndpointResolverInterface)

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

  const adminResponse = () => responseWith([{ name: 'ADMIN_USER' }])

  const payload = (): Record<string, Record<string, unknown> | undefined> => jsonMock.mock.calls[0][0]

  const admissionBlock = (): Record<string, unknown> | undefined =>
    payload().admission as Record<string, unknown> | undefined

  const requestWith = (headers: Record<string, string | string[]>): Request => ({ headers }) as unknown as Request

  /** A gateway whose admission answer is whatever the test plants. */
  const attachGateway = (answer: unknown, capture?: jest.Mock): void => {
    webSocketGatewayAccessService.setProvider({
      admission: (probe: unknown) => {
        capture?.(probe)

        return answer
      },
    } as unknown as AttachedGateway)
  }

  /** The nine members a conforming gateway reports. */
  const FULL = {
    originAdmitted: true,
    allowedOriginCount: 2,
    allowsSameOrigin: true,
    liveSockets: 3,
    ticketsIssued: 9,
    ticketsRefused: 1,
    handshakeRejected: 4,
    rejections: { originNotAllowed: 6, queryStringNotPermitted: 1, unavailable: 2 },
    advertisableOperationCount: 3,
  }

  beforeEach(() => {
    syncGateDiagnostics.clear()
    deploymentDiagnostics.clear()
    syncWebSocketAccessService.clearProvider()
    webSocketGatewayAccessService.clearProvider()
  })

  afterAll(() => {
    syncGateDiagnostics.clear()
    deploymentDiagnostics.clear()
    syncWebSocketAccessService.clearProvider()
    webSocketGatewayAccessService.clearProvider()
  })

  /* ------------------------------------------------------------------------ */
  /* All or nothing                                                           */
  /* ------------------------------------------------------------------------ */

  it('publishes no admission block at all when no gateway is attached', async () => {
    await makeController().getSyncDiagnostics({} as Request, adminResponse())

    // Not an empty object, not zeros: the key is absent, which is what keeps
    // the panel's one honest sentence instead of ten rows reading
    // "not reported".
    expect(admissionBlock()).toBeUndefined()
    expect(JSON.stringify(payload())).not.toContain('admission')
  })

  it('publishes every member once a gateway is attached', async () => {
    attachGateway(FULL)

    await makeController().getSyncDiagnostics(requestWith({ origin: 'https://app.example.test' }), adminResponse())

    // The same members the panel's predicate reads, so the rows it renders are
    // rows that were measured. `advertisableOperationCount` is the ninth: it
    // feeds the CAPABILITY block's notes, which had no producer at all and
    // rendered their own empty note.
    expect(Object.keys(admissionBlock() ?? {}).sort()).toEqual([
      'advertisableOperationCount',
      'allowedOriginCount',
      'allowsSameOrigin',
      'handshakeRejected',
      'liveSockets',
      'originAdmitted',
      'rejections',
      'ticketsIssued',
      'ticketsRefused',
    ])
    expect(admissionBlock()).toEqual(FULL)
  })

  it('publishes nothing rather than a partial block when the gateway answers with something unreadable', async () => {
    // A gateway too old to answer, or one that answered with a non-record:
    // either way the panel must fall back to its sentence rather than render
    // ten rows over one admissible leaf.
    for (const answer of [undefined, null, 'unavailable', 42]) {
      attachGateway(answer)

      await makeController().getSyncDiagnostics({} as Request, adminResponse())

      expect(admissionBlock()).toBeUndefined()
    }
  })

  /* ------------------------------------------------------------------------ */
  /* The counters a client reads                                              */
  /* ------------------------------------------------------------------------ */

  it('carries a counter that advanced between two reads', async () => {
    let refusals = 0
    webSocketGatewayAccessService.setProvider({
      admission: () => ({ ...FULL, rejections: { ...FULL.rejections, originNotAllowed: refusals } }),
    } as unknown as AttachedGateway)

    await makeController().getSyncDiagnostics({} as Request, adminResponse())
    expect((admissionBlock()?.rejections as Record<string, number>).originNotAllowed).toBe(0)

    refusals = 5
    await makeController().getSyncDiagnostics({} as Request, adminResponse())
    expect((admissionBlock()?.rejections as Record<string, number>).originNotAllowed).toBe(5)
  })

  it('asks the gateway about the origin THIS request arrived from, and emits only the answer', async () => {
    const capture = jest.fn()
    attachGateway(FULL, capture)

    await makeController().getSyncDiagnostics(
      requestWith({
        origin: 'https://app.example.test',
        host: 'api.example.test',
        'x-forwarded-proto': 'https',
        cookie: 'session=secret-session-value',
      }),
      adminResponse(),
    )

    expect(capture).toHaveBeenCalledWith({
      origin: 'https://app.example.test',
      host: 'api.example.test',
      forwardedProto: 'https',
      encrypted: false,
      proxyNormalizedHostPort: true,
    })
    // The origin went IN; only a boolean comes out.
    const serialized = JSON.stringify(admissionBlock())
    expect(serialized).not.toContain('app.example.test')
    expect(serialized).not.toContain('secret-session-value')
    expect(admissionBlock()?.originAdmitted).toBe(true)
  })

  it('falls back to the referrer origin, which is all a same-origin pane sends', async () => {
    const capture = jest.fn()
    attachGateway(FULL, capture)

    await makeController().getSyncDiagnostics(
      requestWith({ referer: 'http://localhost:3001/preferences?tab=diagnostics', host: 'localhost' }),
      adminResponse(),
    )

    expect(capture).toHaveBeenCalledWith(expect.objectContaining({ origin: 'http://localhost:3001' }))
  })

  it('survives a request that carries no headers at all', async () => {
    const capture = jest.fn()
    attachGateway(FULL, capture)

    await makeController().getSyncDiagnostics({} as Request, adminResponse())

    expect(statusMock).not.toHaveBeenCalled()
    expect(capture).toHaveBeenCalledWith({ encrypted: false, proxyNormalizedHostPort: true })
  })

  it('never lets the gateway take the endpoint down', async () => {
    webSocketGatewayAccessService.setProvider({
      admission: () => {
        throw new Error('gateway is mid-teardown')
      },
    } as unknown as AttachedGateway)

    await makeController().getSyncDiagnostics({} as Request, adminResponse())

    // The block's absence is already the panel's "nothing reported", so a
    // gateway mid-teardown costs this endpoint its admission block and never
    // its status code — nor the fifteen other fields an operator came for.
    expect(statusMock).not.toHaveBeenCalled()
    expect(admissionBlock()).toBeUndefined()
    expect(payload().gate).toBeDefined()
  })

  it('stays admin-only', async () => {
    attachGateway(FULL)

    await makeController().getSyncDiagnostics({} as Request, responseWith([{ name: 'CORE_USER' }]))

    expect(statusMock).toHaveBeenCalledWith(403)
    expect(jsonMock).toHaveBeenCalledWith({ error: { message: 'Admin role required.' } })
  })

  /* ------------------------------------------------------------------------ */
  /* The emitted contract                                                     */
  /* ------------------------------------------------------------------------ */

  /**
   * Every key the block may carry and what its value may be. A key emitted
   * that is not named here FAILS — the arm a denylist cannot have, because it
   * catches a field added later with no sentinel planted in it.
   */
  const CONTRACT: Record<string, { kind: 'boolean' } | { kind: 'bound'; max: number }> = {
    originAdmitted: { kind: 'boolean' },
    allowedOriginCount: { kind: 'bound', max: MAX_REPORTED_ORIGIN_RULES },
    allowsSameOrigin: { kind: 'boolean' },
    liveSockets: { kind: 'bound', max: MAX_REPORTED_LIVE_SOCKETS },
    ticketsIssued: { kind: 'bound', max: MAX_REPORTED_ADMISSION_EVENTS },
    ticketsRefused: { kind: 'bound', max: MAX_REPORTED_ADMISSION_EVENTS },
    handshakeRejected: { kind: 'bound', max: MAX_REPORTED_ADMISSION_EVENTS },
    advertisableOperationCount: { kind: 'bound', max: MAX_REPORTED_ADVERTISABLE_OPERATIONS },
    'rejections.originNotAllowed': { kind: 'bound', max: MAX_REPORTED_ADMISSION_EVENTS },
    'rejections.queryStringNotPermitted': { kind: 'bound', max: MAX_REPORTED_ADMISSION_EVENTS },
    'rejections.unavailable': { kind: 'bound', max: MAX_REPORTED_ADMISSION_EVENTS },
  }

  const assertContract = (block: Record<string, unknown> | undefined): string[] => {
    if (block === undefined) {
      return []
    }

    const checked: string[] = []
    const visit = (prefix: string, record: Record<string, unknown>): void => {
      for (const [key, value] of Object.entries(record)) {
        if (value === undefined) {
          continue
        }
        const path = `${prefix}${key}`
        if (path === 'rejections') {
          expect(typeof value).toBe('object')
          visit('rejections.', value as Record<string, unknown>)
          continue
        }
        const rule = CONTRACT[path]
        if (rule === undefined) {
          throw new Error(`admission.${path} is emitted but not named in the contract`)
        }
        if (rule.kind === 'boolean') {
          expect(typeof value).toBe('boolean')
        } else {
          expect(typeof value).toBe('number')
          expect(Number.isInteger(value)).toBe(true)
          expect(value as number).toBeGreaterThanOrEqual(0)
          expect(value as number).toBeLessThanOrEqual(rule.max)
        }
        checked.push(path)
      }
    }
    visit('', block)

    return checked
  }

  it('emits nothing but contract-conformant values, with every member populated', async () => {
    // The positive half: a fully-reporting gateway, so the structural
    // assertion is exercising real leaves rather than passing over an empty
    // payload. A flattering denominator is one of the ways one of these tests
    // comes to prove nothing.
    attachGateway(FULL)

    await makeController().getSyncDiagnostics(requestWith({ origin: 'https://app.example.test' }), adminResponse())

    expect(assertContract(admissionBlock())).toHaveLength(11)
  })

  it('emits nothing but contract-conformant values from a gateway answer whose every leaf is a disclosure', async () => {
    // The hostile half. Each leaf is a different SHAPE of leak — the allowlist
    // itself, the origin and address of the last client refused, a
    // structureless secret, a free-form refusal detail, an unbounded figure —
    // plus keys this build has never heard of. The assertion is on what is
    // EMITTED: an unnamed key fails, so a field nobody thought to poison is
    // caught too.
    attachGateway({
      originAdmitted: 'https://evil.example',
      allowedOriginCount: ['https://notes.internal.example:8443', 'tauri://localhost'],
      allowsSameOrigin: 'true',
      liveSockets: 10 ** 12,
      ticketsIssued: Number.NaN,
      ticketsRefused: -1,
      handshakeRejected: 'many',
      // An operation NAME in the field that is declared a count. This report is
      // pasted in public and a name is a server-chosen string, so the value is
      // not read and the sibling key that lists them is not read either.
      advertisableOperationCount: ['SYNC_ITEMS', 'FILES_V1', 'STREAM_ASSISTANT'],
      advertisableOperations: { SYNC_ITEMS: true, FILES_V1: false },
      rejections: {
        originNotAllowed: 'https://evil.example refused 4 times',
        queryStringNotPermitted: 3,
        unavailable: Number.POSITIVE_INFINITY,
        'drop:10.0.3.14': 9,
      },
      allowedOrigins: ['https://notes.internal.example:8443'],
      lastRefusedOrigin: 'https://evil.example',
      lastRefusedAddress: '10.0.3.14',
      connectionTokenSecret: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      refusalDetail: 'connect ECONNREFUSED 10.0.3.14:3306',
      refusedUserUuids: ['00000000-0000-0000-0000-000000000001'],
      socketEndpoint: 'wss://notes.internal.example:8443/sockets/sync',
    })

    await makeController().getSyncDiagnostics(
      requestWith({ origin: 'https://app.example.test', cookie: 'session=secret-session-value' }),
      adminResponse(),
    )

    const checked = assertContract(admissionBlock())

    // Something WAS inspected, so the sweep is not passing on an empty block.
    expect(checked).toEqual(['rejections.queryStringNotPermitted'])
    // The one leaf whose declared type the hostile answer satisfied is the only
    // one that survived. Every other is ABSENT rather than coerced or clamped
    // into a plausible reading no process measured.
    expect(admissionBlock()).toEqual({ rejections: { queryStringNotPermitted: 3 } })

    // Corroborating only, and deliberately second: this is the denylist arm,
    // here to document the shapes rather than to be the boundary.
    const serialized = JSON.stringify(payload())
    for (const planted of [
      'evil.example',
      'internal.example',
      '10.0.3.14',
      'deadbeef',
      'ECONNREFUSED',
      '00000000-0000-0000-0000-000000000001',
      'tauri',
      'secret-session-value',
      'app.example.test',
      '8443',
    ]) {
      expect(serialized).not.toContain(planted)
    }
    // Operation NAMES are checked against the admission block rather than the
    // whole payload, because `protocol.serverOperations` publishes this build's
    // own compile-time list on purpose — a tuple of literals this server
    // compiled in, not a value off any wire. What must never appear is a name
    // that arrived from the GATEWAY, in a field declared to be a count.
    const admissionOnly = JSON.stringify(admissionBlock())
    for (const name of ['SYNC_ITEMS', 'FILES_V1', 'STREAM_ASSISTANT']) {
      expect(admissionOnly).not.toContain(name)
    }
  })
})
