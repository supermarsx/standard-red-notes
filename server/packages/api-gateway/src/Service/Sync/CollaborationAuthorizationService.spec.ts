import type { Request, Response } from 'express'
import { createHash, createHmac } from 'node:crypto'
import { verify } from 'jsonwebtoken'

import { ResponseLocals } from '../../Controller/ResponseLocals'
import { ServiceProxyInterface } from '../Proxy/ServiceProxyInterface'
import { EndpointResolverInterface } from '../Resolver/EndpointResolverInterface'
import {
  CollaborationAuthorizationRequest,
  CollaborationAuthorizationService,
} from './CollaborationAuthorizationService'

// ---------------------------------------------------------------------------
// This is the MINTING half of the v3 collaboration handshake: the only place a
// room capability is signed and the only place a room epoch is derived. The
// verifying half (websocket-gateway) is covered separately.
//
// Two boundaries are asserted here, and both matter:
//
//   1. `serviceProxy.callSyncingServer` — the cross-service access check. Every
//      gateway-side refusal (not ready, aborted, read-only, feature-gated,
//      unidentified, malformed) must be decided BEFORE that call. A test that
//      only asserted `{ authorized: false }` would pass just as happily if the
//      refusal happened after the note's access had already been probed.
//
//   2. Capability minting — a refusal must produce NO signed token at all. Not
//      "a token that later fails to verify": no `capability` key on the grant.
//
// Every "was not called" assertion is backed by a positive control proving the
// same spy does fire on the complete happy path.
// ---------------------------------------------------------------------------

const SECRET = 'collaboration-capability-secret'
const TTL_SECONDS = 300
const NOTE = 'note-uuid-1'
const SECURITY_EPOCH = 'security_epoch_0000000000000001'
const REVISION = 1_700_000_000_000
// Shape every downstream validator enforces: websocket-gateway's auth.ts,
// rooms.ts and syncProtocol.ts all apply this exact pattern to an epoch.
const COLLABORATION_EPOCH_PATTERN = /^[A-Za-z0-9_-]{16,128}$/

type AccessCheckBody = {
  authorized?: unknown
  serverUpdatedAtTimestamp?: unknown
  collaborationSecurityEpoch?: unknown
}

function locals(overrides: Partial<ResponseLocals> = {}): ResponseLocals {
  return {
    authToken: 'auth-token',
    user: { uuid: 'user-1', email: 'user@example.test' },
    roles: [],
    readOnlyAccess: false,
    isFreeUser: false,
    hasContentLimit: false,
    collaborationEnabled: true,
    liveSyncEnabled: true,
    ...overrides,
  } as ResponseLocals
}

function harness(
  options: {
    secret?: string
    ttlSeconds?: number
    status?: number
    body?: AccessCheckBody | { data: AccessCheckBody } | undefined
    wrap?: 'flat' | 'data'
    throws?: boolean
  } = {},
) {
  const body: AccessCheckBody = {
    authorized: true,
    serverUpdatedAtTimestamp: REVISION,
    collaborationSecurityEpoch: SECURITY_EPOCH,
    ...(options.body as AccessCheckBody | undefined),
  }
  const callSyncingServer = jest.fn(async (_request: Request, response: Response) => {
    if (options.throws) {
      throw new Error('syncing-server unreachable')
    }
    const chain = response as unknown as {
      status: (code: number) => typeof chain
      json: (payload: unknown) => typeof chain
    }
    if (options.status !== undefined) {
      chain.status(options.status)
    }
    chain.json(options.wrap === 'data' ? { data: body } : body)
  })
  const serviceProxy = { callSyncingServer } as unknown as ServiceProxyInterface
  const endpointResolver: EndpointResolverInterface = {
    resolveEndpointOrMethodIdentifier: jest.fn(() => 'items/collaboration-authorization'),
  }
  const logger = { error: jest.fn() }
  const service = new CollaborationAuthorizationService(
    serviceProxy,
    endpointResolver,
    options.secret ?? SECRET,
    options.ttlSeconds ?? TTL_SECONDS,
    logger,
  )
  return { service, callSyncingServer, endpointResolver, logger }
}

const request = {} as Request

const discoveryRequest: CollaborationAuthorizationRequest = {
  noteUuid: NOTE,
  collaborationProtocolVersion: 3,
  epochDiscovery: true,
}

function grantRequest(overrides: Record<string, unknown> = {}): CollaborationAuthorizationRequest {
  return {
    noteUuid: NOTE,
    collaborationProtocolVersion: 3,
    expectedRoomEpoch: 'room_epoch_0000000000000001',
    ...overrides,
  } as CollaborationAuthorizationRequest
}

/** Claims of a minted capability, verified against the signing secret. */
function claims(capability: string, secret = SECRET): Record<string, unknown> {
  return verify(capability, secret, { algorithms: ['HS256'] }) as Record<string, unknown>
}

describe('CollaborationAuthorizationService', () => {
  // --- POSITIVE CONTROLS ---------------------------------------------------
  // Without these, every "not called" / "no capability" assertion below could
  // pass because the harness never reaches the backend under any conditions.

  it('CONTROL: a complete grant DOES check access and DOES mint a verifiable capability', async () => {
    const { service, callSyncingServer, endpointResolver } = harness()

    const grant = await service.authorize(
      request,
      locals(),
      grantRequest({ leaseRequestId: 'lease-1', bootstrapChallenge: 'challenge-1' }),
    )

    expect(callSyncingServer).toHaveBeenCalledTimes(1)
    expect(endpointResolver.resolveEndpointOrMethodIdentifier).toHaveBeenCalledWith(
      'POST',
      'items/collaboration-authorization',
    )
    // The access check is scoped to the exact note being authorized.
    expect(callSyncingServer.mock.calls[0][3 as number]).toEqual({ itemUuid: NOTE })
    expect(grant).toMatchObject({ authorized: true, epochDiscovery: false, room: NOTE, expiresIn: TTL_SECONDS })
    const capability = (grant as { capability: string }).capability
    expect(typeof capability).toBe('string')
    expect(claims(capability)).toMatchObject({
      purpose: 'collab-room',
      userUuid: 'user-1',
      room: NOTE,
      collaborationProtocolVersion: 3,
      roomEpoch: 'room_epoch_0000000000000001',
      collaborationSecurityEpoch: SECURITY_EPOCH,
      serverUpdatedAtTimestamp: REVISION,
      leaseRequestId: 'lease-1',
      bootstrapChallenge: 'challenge-1',
    })
  })

  it('CONTROL: discovery DOES check access and returns the epochs', async () => {
    const { service, callSyncingServer } = harness()

    const grant = await service.authorize(request, locals(), discoveryRequest)

    expect(callSyncingServer).toHaveBeenCalledTimes(1)
    expect(grant).toMatchObject({
      authorized: true,
      epochDiscovery: true,
      room: NOTE,
      collaborationProtocolVersion: 3,
      collaborationSecurityEpoch: SECURITY_EPOCH,
      serverUpdatedAtTimestamp: REVISION,
    })
  })

  // --- 1. THE ROOM EPOCH HMAC BINDS WHAT IT CLAIMS -------------------------

  describe('the derived room epoch is a keyed binding, not a guessable label', () => {
    async function epochFor(options: { note?: string; securityEpoch?: string; secret?: string } = {}): Promise<string> {
      const { service } = harness({
        secret: options.secret,
        body: { collaborationSecurityEpoch: options.securityEpoch ?? SECURITY_EPOCH },
      })
      const grant = await service.authorize(request, locals(), {
        noteUuid: options.note ?? NOTE,
        collaborationProtocolVersion: 3,
        epochDiscovery: true,
      })
      return (grant as { roomEpoch: string }).roomEpoch
    }

    it('is deterministic for one note and one security epoch, so peers converge', async () => {
      expect(await epochFor()).toBe(await epochFor())
    })

    it('is bound to the NOTE: another note derives a different epoch', async () => {
      expect(await epochFor({ note: 'note-uuid-2' })).not.toBe(await epochFor())
    })

    it('is bound to the SECURITY EPOCH: a membership rotation derives a different epoch', async () => {
      expect(await epochFor({ securityEpoch: 'security_epoch_0000000000000002' })).not.toBe(await epochFor())
    })

    it('is bound to the SECRET, so a client cannot forge or predict it', async () => {
      const authentic = await epochFor()
      expect(await epochFor({ secret: 'attacker-secret' })).not.toBe(authentic)
      // Keyed, not a bare digest: knowing the public inputs is not enough.
      const unkeyed = createHash('sha256').update(`${NOTE}\u0000${SECURITY_EPOCH}`, 'utf8').digest('base64url')
      expect(authentic).not.toBe(unkeyed)
      expect(authentic).toBe(
        createHmac('sha256', SECRET).update(`${NOTE}\u0000${SECURITY_EPOCH}`, 'utf8').digest('base64url'),
      )
    })

    it('separates its two inputs, so note/epoch boundaries cannot be shifted', async () => {
      // Without the NUL separator, ('ab','c') and ('a','bc') would collide and
      // one note could inherit another note's room.
      const shifted = createHmac('sha256', SECRET).update(`${NOTE}${SECURITY_EPOCH}`, 'utf8').digest('base64url')
      expect(await epochFor()).not.toBe(shifted)
    })

    it('always has the shape every downstream validator requires', async () => {
      // Same class of bug as the epoch-discovery challenge minter: a value the
      // server derives but a client must echo back through validators. base64url
      // is safe HERE only because the epoch pattern permits a leading `_`/`-`,
      // unlike the sync envelope's identifier pattern. Pin it.
      for (let index = 0; index < 64; index += 1) {
        const epoch = await epochFor({ note: `note-${index}`, securityEpoch: `security_epoch_00000000000${index}00` })
        expect(epoch).toMatch(COLLABORATION_EPOCH_PATTERN)
      }
      expect(
        createHmac('sha256', SECRET).update('leading-underscore-probe', 'utf8').digest('base64url').length,
      ).toBeLessThanOrEqual(128)
    })
  })

  // --- 2. WRONG SECRET / TAMPERING FAILS CLOSED ----------------------------

  describe('a minted capability is unforgeable and bound to its subject', () => {
    it('does not verify under a different secret', async () => {
      const { service } = harness()
      const grant = await service.authorize(request, locals(), grantRequest())
      const capability = (grant as { capability: string }).capability

      expect(() => claims(capability, 'attacker-secret')).toThrow()
      expect(() => claims(capability)).not.toThrow()
    })

    it('does not verify once any claim is tampered with', async () => {
      const { service } = harness()
      const grant = await service.authorize(request, locals(), grantRequest())
      const [header, payload, signature] = (grant as { capability: string }).capability.split('.')
      const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>
      const forgedPayload = Buffer.from(JSON.stringify({ ...decoded, room: 'someone-elses-note' }), 'utf8').toString(
        'base64url',
      )

      expect(() => claims(`${header}.${forgedPayload}.${signature}`)).toThrow()
    })

    it('names the exact user and room it was issued for, so it cannot be presented elsewhere', async () => {
      const { service } = harness()
      const mine = await service.authorize(request, locals(), grantRequest())
      const theirs = await service.authorize(
        request,
        locals({ user: { uuid: 'user-2', email: 'other@example.test' } }),
        grantRequest({ noteUuid: 'note-uuid-2' }),
      )

      expect(claims((mine as { capability: string }).capability)).toMatchObject({ userUuid: 'user-1', room: NOTE })
      expect(claims((theirs as { capability: string }).capability)).toMatchObject({
        userUuid: 'user-2',
        room: 'note-uuid-2',
      })
    })

    it('carries a bounded expiry and an issuance instant', async () => {
      const { service } = harness({ ttlSeconds: 30 })
      const grant = await service.authorize(request, locals(), grantRequest())
      const payload = claims((grant as { capability: string }).capability) as { exp: number; iat: number } & Record<
        string,
        unknown
      >

      expect(payload.exp - payload.iat).toBe(30)
      expect(Number.isSafeInteger(payload.collaborationAuthorizationIssuedAt)).toBe(true)
      expect(Number(payload.collaborationAuthorizationIssuedAt)).toBeGreaterThan(0)
    })
  })

  // --- 3. THE SECURITY EPOCH IS SERVER-DERIVED, NEVER CLIENT-SUPPLIED ------

  describe('the security epoch comes from syncing-server, not from the caller', () => {
    it('ignores a client-supplied security epoch and signs the server one', async () => {
      const { service } = harness()

      const grant = await service.authorize(
        request,
        locals(),
        grantRequest({
          collaborationSecurityEpoch: 'attacker_security_epoch_00000001',
          serverUpdatedAtTimestamp: 999,
        }),
      )

      expect(claims((grant as { capability: string }).capability)).toMatchObject({
        collaborationSecurityEpoch: SECURITY_EPOCH,
        serverUpdatedAtTimestamp: REVISION,
      })
      expect(grant).toMatchObject({ collaborationSecurityEpoch: SECURITY_EPOCH, serverUpdatedAtTimestamp: REVISION })
    })

    it('reads the epoch from either response envelope shape without trusting the caller', async () => {
      const flat = harness()
      const wrapped = harness({ wrap: 'data' })

      const flatGrant = await flat.service.authorize(request, locals(), discoveryRequest)
      const wrappedGrant = await wrapped.service.authorize(request, locals(), discoveryRequest)

      expect(flatGrant).toMatchObject({ authorized: true, collaborationSecurityEpoch: SECURITY_EPOCH })
      expect(wrappedGrant).toMatchObject({ authorized: true, collaborationSecurityEpoch: SECURITY_EPOCH })
    })

    // The room epoch IS deliberately caller-asserted (Redis owns rotation and
    // is the arbiter), so this pins the intended split: the caller may propose
    // a room generation, but never its own membership generation.
    it('signs the caller-proposed room epoch while the security epoch stays server-derived', async () => {
      const { service } = harness()

      const grant = await service.authorize(
        request,
        locals(),
        grantRequest({ expectedRoomEpoch: 'rotated_room_epoch_00000000001' }),
      )

      expect(claims((grant as { capability: string }).capability)).toMatchObject({
        roomEpoch: 'rotated_room_epoch_00000000001',
        collaborationSecurityEpoch: SECURITY_EPOCH,
      })
    })
  })

  // --- 4. DISCOVERY MINTS NOTHING -----------------------------------------

  describe('discovery cannot produce a capability', () => {
    it('returns epochs only, with no capability and no expiry', async () => {
      const { service } = harness()

      const grant = await service.authorize(request, locals(), discoveryRequest)

      expect(grant).not.toHaveProperty('capability')
      expect(grant).not.toHaveProperty('expiresIn')
      expect(grant).not.toHaveProperty('leaseRequestId')
      expect(grant).not.toHaveProperty('bootstrapChallenge')
      // No JWT smuggled into any other field either.
      expect(JSON.stringify(grant)).not.toMatch(/eyJ/)
    })

    it.each([
      ['an expected room epoch', { expectedRoomEpoch: 'room_epoch_0000000000000001' }],
      ['a lease request id', { leaseRequestId: 'lease-1' }],
      ['a bootstrap challenge', { leaseRequestId: 'lease-1', bootstrapChallenge: 'challenge-1' }],
    ])('REFUSES a discovery request smuggling %s, before checking access', async (_label, smuggled) => {
      const { service, callSyncingServer } = harness()

      const grant = await service.authorize(request, locals(), {
        noteUuid: NOTE,
        collaborationProtocolVersion: 3,
        epochDiscovery: true,
        ...smuggled,
      } as unknown as CollaborationAuthorizationRequest)

      expect(grant).toEqual({ authorized: false })
      expect(callSyncingServer).not.toHaveBeenCalled()
    })
  })

  // --- 5. GATEWAY-SIDE REFUSALS NEVER REACH SYNCING-SERVER -----------------

  describe('a refusal decided at the gateway never probes the note', () => {
    it.each([
      ['a read-only session flag', locals({ readOnlyAccess: true })],
      [
        'a read-only session record',
        locals({ session: { readonly_access: true } as unknown as ResponseLocals['session'] }),
      ],
      ['a read-scoped MCP token', locals({ mcpScope: { access: 'read' } })],
      ['collaboration disabled for the user', locals({ collaborationEnabled: false })],
      ['an unidentified caller', locals({ user: undefined as unknown as ResponseLocals['user'] })],
      ['an empty user uuid', locals({ user: { uuid: '', email: 'user@example.test' } })],
    ])('refuses %s without calling syncing-server and without minting', async (_label, callerLocals) => {
      const { service, callSyncingServer } = harness()

      const grant = await service.authorize(request, callerLocals, grantRequest())

      expect(grant).toEqual({ authorized: false })
      expect(grant).not.toHaveProperty('capability')
      expect(callSyncingServer).not.toHaveBeenCalled()
    })

    it.each([
      ['no signing secret', { secret: '' }],
      ['a TTL below the floor', { ttlSeconds: 29 }],
      ['a TTL above the ceiling', { ttlSeconds: 901 }],
      ['a fractional TTL', { ttlSeconds: 300.5 }],
    ])('refuses when configured with %s, without calling syncing-server', async (_label, options) => {
      const { service, callSyncingServer } = harness(options)

      expect(service.ready()).toBe(false)
      await expect(service.authorize(request, locals(), grantRequest())).resolves.toEqual({ authorized: false })
      expect(callSyncingServer).not.toHaveBeenCalled()
    })

    it.each([
      ['a legacy protocol version', grantRequest({ collaborationProtocolVersion: 2 })],
      ['a missing protocol version', grantRequest({ collaborationProtocolVersion: undefined })],
      ['an empty note uuid', grantRequest({ noteUuid: '' })],
      ['an oversized note uuid', grantRequest({ noteUuid: 'n'.repeat(201) })],
      ['a malformed expected room epoch', grantRequest({ expectedRoomEpoch: 'too-short' })],
      ['an expected room epoch with a separator', grantRequest({ expectedRoomEpoch: 'room_epoch_000001:injected' })],
      ['a missing expected room epoch', grantRequest({ expectedRoomEpoch: undefined })],
      ['an empty lease request id', grantRequest({ leaseRequestId: '' })],
      ['an oversized lease request id', grantRequest({ leaseRequestId: 'l'.repeat(129) })],
      [
        'an oversized bootstrap challenge',
        grantRequest({ leaseRequestId: 'lease-1', bootstrapChallenge: 'c'.repeat(129) }),
      ],
      ['a bootstrap challenge with no lease request id', grantRequest({ bootstrapChallenge: 'challenge-1' })],
    ])('refuses %s without calling syncing-server', async (_label, malformed) => {
      const { service, callSyncingServer } = harness()

      const grant = await service.authorize(request, locals(), malformed)

      expect(grant).toEqual({ authorized: false })
      expect(callSyncingServer).not.toHaveBeenCalled()
    })

    it('refuses an already-aborted request without calling syncing-server', async () => {
      const { service, callSyncingServer } = harness()
      const controller = new AbortController()
      controller.abort()

      const grant = await service.authorize(request, locals(), grantRequest(), controller.signal)

      expect(grant).toEqual({ authorized: false })
      expect(callSyncingServer).not.toHaveBeenCalled()
    })
  })

  // --- 6. A FAILED ACCESS CHECK NEVER MINTS -------------------------------

  describe('nothing is minted unless syncing-server authorized this note', () => {
    it.each([
      ['syncing-server denies access', { body: { authorized: false } }],
      ['syncing-server omits the authorization', { body: { authorized: undefined } }],
      ['authorization is a truthy non-boolean', { body: { authorized: 'yes' } }],
      ['the call throws', { throws: true }],
      ['the response is 403', { status: 403 }],
      ['the response is 500', { status: 500 }],
      ['the security epoch is missing', { body: { collaborationSecurityEpoch: undefined } }],
      ['the security epoch is malformed', { body: { collaborationSecurityEpoch: 'short' } }],
      ['the security epoch is not a string', { body: { collaborationSecurityEpoch: 12345678901234567 } }],
      ['the revision is missing', { body: { serverUpdatedAtTimestamp: undefined } }],
      ['the revision is zero', { body: { serverUpdatedAtTimestamp: 0 } }],
      ['the revision is fractional', { body: { serverUpdatedAtTimestamp: 1.5 } }],
      ['the revision is not a number', { body: { serverUpdatedAtTimestamp: '1700000000000' } }],
    ])('refuses when %s, and mints nothing', async (_label, options) => {
      const { service, callSyncingServer } = harness(options as Parameters<typeof harness>[0])

      const grant = await service.authorize(request, locals(), grantRequest())

      expect(callSyncingServer).toHaveBeenCalledTimes(1)
      expect(grant).toEqual({ authorized: false })
      expect(grant).not.toHaveProperty('capability')
    })

    it('refuses without minting when the caller aborts while the access check is in flight', async () => {
      const controller = new AbortController()
      const { service, callSyncingServer } = harness()
      ;(callSyncingServer as jest.Mock).mockImplementation(async (_request: Request, response: Response) => {
        controller.abort()
        ;(response as unknown as { json: (payload: unknown) => void }).json({
          authorized: true,
          serverUpdatedAtTimestamp: REVISION,
          collaborationSecurityEpoch: SECURITY_EPOCH,
        })
      })

      const grant = await service.authorize(request, locals(), grantRequest(), controller.signal)

      expect(grant).toEqual({ authorized: false })
      expect(grant).not.toHaveProperty('capability')
    })

    it('logs the transport failure without leaking the note or the secret', async () => {
      const { service, logger } = harness({ throws: true })

      await service.authorize(request, locals(), grantRequest())

      expect(logger.error).toHaveBeenCalledTimes(1)
      expect(JSON.stringify(logger.error.mock.calls)).not.toContain(SECRET)
      expect(JSON.stringify(logger.error.mock.calls)).not.toContain(NOTE)
    })
  })
})
