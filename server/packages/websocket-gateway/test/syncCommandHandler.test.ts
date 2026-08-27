import { describe, expect, it, vi } from 'vitest'

import { InMemorySyncAuthTicketStore } from '../src/auth.js'
import {
  InMemorySyncCommandLeaseRegistry,
  InMemorySyncSocketBudget,
  type SyncCommandLeaseRegistry,
  type SyncSocketBudget,
} from '../src/registry.js'
import {
  SyncCommandHandler,
  type SyncApiRpcAdapter,
  type SyncCollaborationAuthorizationAdapter,
  type SyncCommandBackendAdapter,
  type SyncCommandMetrics,
  type SyncLiveAuthorizationAdapter,
  type SyncSocket,
  type SyncInviteEventsAdapter,
} from '../src/syncCommandHandler.js'
import {
  MAX_SYNC_BUFFERED_BYTES,
  MAX_SYNC_FRAME_BYTES,
  MAX_SYNC_RESUME_SEQUENCE,
  createSyncServerFrame,
  digestSyncCommandBody,
  parseSyncClientFrame,
  syncPayloadLength,
  type JsonObject,
} from '../src/syncProtocol.js'

class FakeSocket implements SyncSocket {
  bufferedAmount = 0
  throwOnSend = false
  throwOnClose = false
  readonly frames: JsonObject[] = []
  readonly closes: Array<{ code?: number; reason?: string }> = []

  send(data: string): void {
    if (this.throwOnSend) {
      throw new Error('socket send failed')
    }
    this.frames.push(JSON.parse(data) as JsonObject)
  }

  close(code?: number, reason?: string): void {
    if (this.throwOnClose) {
      throw new Error('socket close failed')
    }
    this.closes.push({ code, reason })
  }
}

function rawFrame(frame: JsonObject): string {
  return JSON.stringify(frame)
}

function authFrame(ticket: string, deviceId = 'device-1', resumeSequence?: number): JsonObject {
  const payload = { ticket, deviceId, ...(resumeSequence === undefined ? {} : { resumeSequence }) }
  return {
    version: 1,
    channel: 'sync',
    type: 'AUTH',
    requestId: 'auth-request',
    commandId: 'auth-command',
    sequence: 0,
    payloadLength: syncPayloadLength(payload),
    payload,
  }
}

function commandFrame(
  commandId: string,
  sequence: number,
  body: JsonObject = { api: '20200115', items: [] },
): JsonObject {
  const payload = { command: 'SYNC_ITEMS', body }
  return {
    version: 1,
    channel: 'sync',
    type: 'COMMAND',
    requestId: `request-${commandId}`,
    commandId,
    sequence,
    payloadLength: syncPayloadLength(payload),
    payload,
    digest: digestSyncCommandBody(body),
  }
}

function collaborationAuthorizationFrame(
  sequence: number,
  payload: JsonObject = {
    noteUuid: 'note-1',
    collaborationProtocolVersion: 3,
    epochDiscovery: true,
  },
  requestId = `collaboration-request-${sequence}`,
): JsonObject {
  return {
    version: 1,
    channel: 'sync',
    type: 'COLLABORATION_AUTHORIZE',
    requestId,
    commandId: `collaboration-command-${sequence}`,
    sequence,
    payloadLength: syncPayloadLength(payload),
    payload,
  }
}

function statusFrame(commandId: string, sequence: number, digest: string): JsonObject {
  return {
    version: 1,
    channel: 'sync',
    type: 'STATUS',
    requestId: `status-${commandId}`,
    commandId,
    sequence,
    payloadLength: 2,
    payload: {},
    digest,
  }
}

function pingFrame(sequence: number): JsonObject {
  return {
    version: 1,
    channel: 'sync',
    type: 'PING',
    requestId: 'ping-request',
    commandId: 'ping-command',
    sequence,
    payloadLength: 2,
    payload: {},
  }
}

function rpcFrame(
  sequence: number,
  overrides: Partial<{
    requestId: string
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
    path: string
    body: unknown
    stream: boolean
    initialCreditBytes: number
    deadlineMs: number
    idempotencyKey: string
  }> = {},
): JsonObject {
  const payload = {
    method: overrides.method ?? 'GET',
    path: overrides.path ?? '/v1/users/me',
    deadlineMs: overrides.deadlineMs ?? 30_000,
    initialCreditBytes: overrides.initialCreditBytes ?? 256 * 1024,
    stream: overrides.stream ?? false,
    ...(Object.hasOwn(overrides, 'body') ? { body: overrides.body } : {}),
    ...(overrides.idempotencyKey ? { idempotencyKey: overrides.idempotencyKey } : {}),
  }
  const requestId = overrides.requestId ?? `rpc-request-${sequence}`
  return {
    version: 1,
    channel: 'sync',
    type: 'RPC_REQUEST',
    requestId,
    commandId: requestId,
    sequence,
    payloadLength: syncPayloadLength(payload),
    payload,
  }
}

function rpcCreditFrame(sequence: number, targetRequestId: string, creditBytes: number): JsonObject {
  const payload = { targetRequestId, creditBytes }
  return {
    version: 1,
    channel: 'sync',
    type: 'RPC_CREDIT',
    requestId: `rpc-credit-${sequence}`,
    commandId: `rpc-credit-${sequence}`,
    sequence,
    payloadLength: syncPayloadLength(payload),
    payload,
  }
}

function rpcCancelFrame(sequence: number, targetRequestId: string): JsonObject {
  const payload = { targetRequestId }
  return {
    version: 1,
    channel: 'sync',
    type: 'RPC_CANCEL',
    requestId: `rpc-cancel-${sequence}`,
    commandId: `rpc-cancel-${sequence}`,
    sequence,
    payloadLength: syncPayloadLength(payload),
    payload,
  }
}

function inviteSubscribeFrame(sequence: number, cursor?: string, limit = 1): JsonObject {
  const payload = { ...(cursor === undefined ? {} : { cursor }), limit }
  return {
    version: 1,
    channel: 'sync',
    type: 'INVITE_SUBSCRIBE',
    requestId: 'invite-subscription',
    commandId: 'invite-subscription',
    sequence,
    payloadLength: syncPayloadLength(payload),
    payload,
  }
}

function inviteAckFrame(sequence: number, cursor: string): JsonObject {
  const payload = { cursor }
  return {
    version: 1,
    channel: 'sync',
    type: 'INVITE_ACK',
    requestId: `invite-ack-${sequence}`,
    commandId: `invite-ack-${sequence}`,
    sequence,
    payloadLength: syncPayloadLength(payload),
    payload,
  }
}

const optionalString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

// FakeSocket records frames as JsonObject (Record<string, unknown>), so `.payload` is
// unknown. Narrow it by checking, not asserting: a frame that never arrived or that
// carries a non-object payload fails here with a readable message instead of a
// downstream `undefined is not an object`.
const isJsonObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

function payloadOf(frame: JsonObject | undefined): JsonObject {
  const payload = frame?.payload
  if (!isJsonObject(payload)) {
    throw new Error(`expected a frame with an object payload, got ${JSON.stringify(frame)}`)
  }
  return payload
}

function enqueue(handler: SyncCommandHandler, frame: JsonObject): void {
  const raw = rawFrame(frame)
  handler.enqueue(raw, Buffer.byteLength(raw))
}

// vi.fn() infers its implementation's return type before the assignment, so a bare
// `async () => ({ authorized: true })` widens to `{ authorized: boolean }` and no
// longer matches the discriminated union. Passing the adapter's own method type as
// the type argument contextually types the implementation instead, which keeps the
// literal discriminants and makes the compiler demand every partner field.
const allowAuthorization = (): SyncLiveAuthorizationAdapter => ({
  ready: () => true,
  authorize: vi.fn<SyncLiveAuthorizationAdapter['authorize']>(async () => ({ authorized: true })),
})

const committingBackend = (): SyncCommandBackendAdapter => ({
  ready: () => true,
  execute: vi.fn<SyncCommandBackendAdapter['execute']>(async (input) => ({
    digest: input.digest,
    payload: { saved: true },
  })),
  status: vi.fn<SyncCommandBackendAdapter['status']>(async (input) => ({
    status: 'COMMITTED',
    digest: input.digest,
    payload: { saved: true },
  })),
})

async function authenticatedHandler(
  options: {
    tickets?: InMemorySyncAuthTicketStore
    leases?: SyncCommandLeaseRegistry
    socket?: FakeSocket
    authorization?: SyncLiveAuthorizationAdapter
    backend?: SyncCommandBackendAdapter
    collaborationAuthorization?: SyncCollaborationAuthorizationAdapter
    apiRpc?: SyncApiRpcAdapter
    inviteEvents?: SyncInviteEventsAdapter
    requireSharedState?: boolean
    metrics?: SyncCommandMetrics
    deviceId?: string
    resumeSequence?: number
    backendTimeoutMs?: number
    maxBufferedBytes?: number
    isEnabled?: () => boolean
    socketBudget?: SyncSocketBudget
    ownerId?: string
    leaseRenewIntervalMs?: number
    socketBudgetRenewIntervalMs?: number
  } = {},
): Promise<{ handler: SyncCommandHandler; socket: FakeSocket; tickets: InMemorySyncAuthTicketStore }> {
  const tickets = options.tickets ?? new InMemorySyncAuthTicketStore()
  const socket = options.socket ?? new FakeSocket()
  const deviceId = options.deviceId ?? 'device-1'
  const issued = await tickets.issue({
    userUuid: 'user-1',
    sessionUuid: 'session-1',
    deviceId,
    authorization: 'Bearer session-token',
  })
  const handler = new SyncCommandHandler({
    socket,
    ownerId: options.ownerId ?? `owner-${Math.random()}`,
    tickets,
    leases: options.leases ?? new InMemorySyncCommandLeaseRegistry(),
    socketBudget: options.socketBudget ?? new InMemorySyncSocketBudget(),
    authorization: options.authorization ?? allowAuthorization(),
    backend: options.backend ?? committingBackend(),
    collaborationAuthorization: options.collaborationAuthorization,
    apiRpc: options.apiRpc,
    inviteEvents: options.inviteEvents,
    requireSharedState: options.requireSharedState,
    metrics: options.metrics,
    isEnabled: options.isEnabled ?? (() => true),
    backendTimeoutMs: options.backendTimeoutMs,
    maxBufferedBytes: options.maxBufferedBytes,
    leaseRenewIntervalMs: options.leaseRenewIntervalMs,
    socketBudgetRenewIntervalMs: options.socketBudgetRenewIntervalMs,
  })
  enqueue(handler, authFrame(issued.ticket, deviceId, options.resumeSequence))
  await vi.waitFor(() => expect(socket.frames.at(-1)?.type).toBe('AUTHENTICATED'))
  return { handler, socket, tickets }
}

describe('SyncCommandHandler', () => {
  it('rejects invalid distributed renewal intervals at construction', () => {
    const base = {
      socket: new FakeSocket(),
      ownerId: 'owner',
      tickets: new InMemorySyncAuthTicketStore(),
      leases: new InMemorySyncCommandLeaseRegistry(),
      socketBudget: new InMemorySyncSocketBudget(),
      authorization: allowAuthorization(),
      backend: committingBackend(),
      isEnabled: () => true,
    }
    expect(() => new SyncCommandHandler({ ...base, leaseRenewIntervalMs: 0 })).toThrow(/renewal interval/i)
    expect(() => new SyncCommandHandler({ ...base, socketBudgetRenewIntervalMs: 1.5 })).toThrow(/renewal interval/i)
  })

  it('replays and live-delivers durable invite batches only after the exact prior cursor is acknowledged', async () => {
    const eventOne = {
      version: 1,
      eventId: '11111111-1111-4111-8111-111111111111',
      streamPosition: 'cursor-1',
      kind: 'shared-vault-invite',
      action: 'created',
      inviteUuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      sharedVaultUuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      occurredAt: 1,
    }
    const eventTwo = {
      version: 1,
      eventId: '22222222-2222-4222-8222-222222222222',
      streamPosition: 'cursor-2',
      kind: 'subscription-invite',
      action: 'updated',
      inviteUuid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      occurredAt: 2,
    }
    const eventThree = {
      version: 1,
      eventId: '33333333-3333-4333-8333-333333333333',
      streamPosition: 'cursor-3',
      kind: 'subscription-invite',
      action: 'accepted',
      inviteUuid: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      occurredAt: 3,
    }
    const events = [eventOne, eventTwo]
    const listeners = new Set<() => void>()
    let authoritativeApplyCompleted = false
    const positions = new Map([
      ['cursor-0', 0],
      ['cursor-1', 1],
      ['cursor-2', 2],
      ['cursor-3', 3],
    ])
    const readAfter = vi.fn(async (_userUuid: string, cursor: string, limit: number) => {
      if (cursor === 'cursor-1') {
        expect(authoritativeApplyCompleted).toBe(true)
      }
      const after = positions.get(cursor) ?? 0
      const available = events.slice(after)
      const selected = available.slice(0, limit)
      return {
        previousCursor: cursor,
        events: selected,
        nextCursor: selected.at(-1)?.streamPosition ?? cursor,
        hasMore: available.length > selected.length,
      }
    })
    const inviteEvents: SyncInviteEventsAdapter = {
      distribution: 'shared',
      ready: () => true,
      tail: vi.fn(async () => `cursor-${events.length}`),
      readAfter,
      subscribeAvailability: vi.fn((_userUuid, listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }),
    }

    const { handler, socket } = await authenticatedHandler({ inviteEvents, requireSharedState: true })
    expect(socket.frames[0].payload).toMatchObject({ operations: ['SYNC_ITEMS', 'INVITE_EVENTS'] })

    enqueue(handler, inviteSubscribeFrame(1, 'cursor-0'))
    await vi.waitFor(() => expect(socket.frames.filter((frame) => frame.type === 'INVITE_BATCH')).toHaveLength(1))
    expect(socket.frames.at(-1)?.payload).toMatchObject({
      previousCursor: 'cursor-0',
      events: [eventOne],
      nextCursor: 'cursor-1',
      hasMore: true,
    })
    expect(readAfter).toHaveBeenCalledTimes(1)
    expect(readAfter).toHaveBeenLastCalledWith('user-1', 'cursor-0', 1, expect.any(AbortSignal))

    for (const listener of listeners) {
      listener()
    }
    await Promise.resolve()
    expect(readAfter).toHaveBeenCalledTimes(1)
    expect(socket.frames.filter((frame) => frame.type === 'INVITE_BATCH')).toHaveLength(1)

    authoritativeApplyCompleted = true
    enqueue(handler, inviteAckFrame(2, 'cursor-1'))
    await vi.waitFor(() => expect(socket.frames.filter((frame) => frame.type === 'INVITE_BATCH')).toHaveLength(2))
    expect(socket.frames.at(-1)?.payload).toMatchObject({
      previousCursor: 'cursor-1',
      events: [eventTwo],
      nextCursor: 'cursor-2',
      hasMore: false,
    })

    enqueue(handler, inviteAckFrame(3, 'cursor-2'))
    await vi.waitFor(() => expect(readAfter).toHaveBeenCalledTimes(3))
    expect(socket.frames.filter((frame) => frame.type === 'INVITE_BATCH')).toHaveLength(2)

    events.push(eventThree)
    for (const listener of listeners) {
      listener()
    }
    await vi.waitFor(() => expect(socket.frames.filter((frame) => frame.type === 'INVITE_BATCH')).toHaveLength(3))
    expect(socket.frames.at(-1)?.payload).toMatchObject({
      previousCursor: 'cursor-2',
      events: [eventThree],
      nextCursor: 'cursor-3',
      hasMore: false,
    })

    handler.disconnect()
    expect(listeners.size).toBe(0)
  })

  it('strictly replays every membership and application-state invalidation shape', async () => {
    const sharedVaultUuid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const memberUserUuid = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    const membershipUuid = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    const inviteUuid = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
    const membershipDetails = [
      { action: 'invited', inviteUuid, role: 'write' },
      { action: 'accepted', membershipUuid, inviteUuid, role: 'write' },
      { action: 'joined', membershipUuid, role: 'read' },
      { action: 'left', membershipUuid },
      { action: 'revoked', membershipUuid },
      { action: 'role-changed', membershipUuid, role: 'admin' },
    ]
    const membershipEvents = membershipDetails.map((details, index) => ({
      version: 1,
      eventId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      streamPosition: `cursor-${index + 1}`,
      kind: 'shared-vault-membership',
      sharedVaultUuid,
      memberUserUuid,
      revision: String(index + 1),
      occurredAt: index + 1,
      ...details,
    }))
    const applicationEvents = ['updated', 'invalidated'].map((action, index) => ({
      version: 1,
      eventId: `00000000-0000-4000-8000-${String(index + 7).padStart(12, '0')}`,
      streamPosition: `cursor-${index + 7}`,
      kind: 'application-state',
      action,
      resource: index === 0 ? 'files-metadata' : 'account',
      ...(index === 0 ? { resourceUuid: sharedVaultUuid } : {}),
      revision: String(index + 7),
      occurredAt: index + 7,
    }))
    const events = [...membershipEvents, ...applicationEvents]
    const inviteEvents: SyncInviteEventsAdapter = {
      distribution: 'shared',
      ready: () => true,
      tail: vi.fn(async () => 'cursor-8'),
      readAfter: vi.fn(async (_userUuid, cursor) => ({
        previousCursor: cursor,
        events,
        nextCursor: 'cursor-8',
        hasMore: false,
      })),
      subscribeAvailability: vi.fn(() => () => undefined),
    }

    const { handler, socket } = await authenticatedHandler({ inviteEvents, requireSharedState: true })
    enqueue(handler, inviteSubscribeFrame(1, 'cursor-0', events.length))
    await vi.waitFor(() => expect(socket.frames.at(-1)?.type).toBe('INVITE_BATCH'))
    expect(socket.frames.at(-1)?.payload).toMatchObject({ events, nextCursor: 'cursor-8' })
    handler.disconnect()
  })

  it.each([
    ['an extra field', { extra: true }],
    ['binary-shaped data', Buffer.from('not-json')],
  ])('fails closed when an application-state replay contains %s', async (_label, invalidValue) => {
    const validEvent = {
      version: 1,
      eventId: '11111111-1111-4111-8111-111111111111',
      streamPosition: 'cursor-1',
      kind: 'application-state',
      action: 'updated',
      resource: 'items',
      revision: '1',
      occurredAt: 1,
    }
    const event = Buffer.isBuffer(invalidValue) ? invalidValue : { ...validEvent, ...invalidValue }
    const inviteEvents: SyncInviteEventsAdapter = {
      distribution: 'shared',
      ready: () => true,
      tail: vi.fn(async () => 'cursor-1'),
      readAfter: vi.fn(async (_userUuid, cursor) => ({
        previousCursor: cursor,
        events: [event as unknown as JsonObject],
        nextCursor: 'cursor-1',
        hasMore: false,
      })),
      subscribeAvailability: vi.fn(() => () => undefined),
    }

    const { handler, socket } = await authenticatedHandler({ inviteEvents, requireSharedState: true })
    enqueue(handler, inviteSubscribeFrame(1, 'cursor-0'))
    await vi.waitFor(() => expect(socket.frames.at(-1)?.type).toBe('ERROR'))
    expect(socket.frames.at(-1)?.payload).toMatchObject({ code: 'INVITE_STORE_UNAVAILABLE' })
    expect(socket.frames.some((frame) => frame.type === 'INVITE_BATCH')).toBe(false)
    handler.disconnect()
  })

  it('rejects every malformed durable invite replay boundary before exposing event metadata', async () => {
    const sharedInvite = {
      version: 1,
      eventId: '11111111-1111-4111-8111-111111111111',
      streamPosition: 'cursor-1',
      kind: 'shared-vault-invite',
      action: 'created',
      inviteUuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      sharedVaultUuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      occurredAt: 1,
    }
    const subscriptionInvite = {
      version: 1,
      eventId: '22222222-2222-4222-8222-222222222222',
      streamPosition: 'cursor-1',
      kind: 'subscription-invite',
      action: 'updated',
      inviteUuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      occurredAt: 1,
    }
    const acceptedMembership = {
      version: 1,
      eventId: '33333333-3333-4333-8333-333333333333',
      streamPosition: 'cursor-1',
      kind: 'shared-vault-membership',
      action: 'accepted',
      sharedVaultUuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      memberUserUuid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      membershipUuid: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      inviteUuid: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      role: 'write',
      revision: '1',
      occurredAt: 1,
    }
    const invitedMembership = {
      ...acceptedMembership,
      action: 'invited',
      membershipUuid: undefined,
    }
    const leftMembership = {
      ...acceptedMembership,
      action: 'left',
      inviteUuid: undefined,
      role: undefined,
    }
    const roleChangedMembership = {
      ...acceptedMembership,
      action: 'role-changed',
      inviteUuid: undefined,
    }
    const applicationState = {
      version: 1,
      eventId: '44444444-4444-4444-8444-444444444444',
      streamPosition: 'cursor-1',
      kind: 'application-state',
      action: 'updated',
      resource: 'items',
      revision: '1',
      occurredAt: 1,
    }
    const replayWith = (event: unknown): unknown => ({
      previousCursor: 'cursor-0',
      events: [event],
      nextCursor: 'cursor-1',
      hasMore: false,
    })
    const malformedEvents: unknown[] = [
      null,
      [],
      'event',
      { ...sharedInvite, version: 2 },
      { ...sharedInvite, eventId: 1 },
      { ...sharedInvite, eventId: 'invalid' },
      { ...sharedInvite, streamPosition: 1 },
      { ...sharedInvite, streamPosition: '' },
      { ...sharedInvite, streamPosition: 'x'.repeat(2_049) },
      { ...sharedInvite, occurredAt: 1.5 },
      { ...sharedInvite, occurredAt: 0 },
      { ...sharedInvite, kind: 1 },
      { ...sharedInvite, kind: 'unknown' },
      { ...sharedInvite, extra: true },
      { ...sharedInvite, action: 1 },
      { ...sharedInvite, action: 'unknown' },
      { ...sharedInvite, inviteUuid: 1 },
      { ...sharedInvite, inviteUuid: 'invalid' },
      { ...sharedInvite, sharedVaultUuid: undefined },
      { ...subscriptionInvite, extra: true },
      { ...subscriptionInvite, action: 1 },
      { ...subscriptionInvite, action: 'unknown' },
      { ...subscriptionInvite, inviteUuid: undefined },
      { ...acceptedMembership, extra: true },
      { ...acceptedMembership, action: 1 },
      { ...acceptedMembership, action: 'unknown' },
      { ...acceptedMembership, sharedVaultUuid: 'invalid' },
      { ...acceptedMembership, memberUserUuid: undefined },
      { ...acceptedMembership, revision: 1 },
      { ...acceptedMembership, revision: '0' },
      { ...acceptedMembership, membershipUuid: undefined },
      { ...acceptedMembership, inviteUuid: undefined },
      { ...acceptedMembership, role: undefined },
      { ...invitedMembership, membershipUuid: acceptedMembership.membershipUuid },
      { ...invitedMembership, inviteUuid: undefined },
      { ...invitedMembership, role: undefined },
      { ...leftMembership, inviteUuid: acceptedMembership.inviteUuid },
      { ...leftMembership, role: 'read' },
      { ...roleChangedMembership, role: 1 },
      { ...roleChangedMembership, role: 'owner' },
      { ...applicationState, extra: true },
      { ...applicationState, action: 1 },
      { ...applicationState, action: 'unknown' },
      { ...applicationState, resource: 1 },
      { ...applicationState, resource: 'unknown' },
      { ...applicationState, resourceUuid: 1 },
      { ...applicationState, resourceUuid: 'invalid' },
      { ...applicationState, revision: undefined },
      { ...applicationState, revision: '0' },
    ]
    const malformedReplays: unknown[] = [
      null,
      [],
      'replay',
      { previousCursor: 'wrong', events: [], nextCursor: 'cursor-0', hasMore: false },
      { previousCursor: 'cursor-0', events: [], nextCursor: 1, hasMore: false },
      { previousCursor: 'cursor-0', events: [], nextCursor: '', hasMore: false },
      { previousCursor: 'cursor-0', events: [], nextCursor: 'x'.repeat(2_049), hasMore: false },
      { previousCursor: 'cursor-0', events: {}, nextCursor: 'cursor-0', hasMore: false },
      {
        previousCursor: 'cursor-0',
        events: [sharedInvite, sharedInvite, sharedInvite],
        nextCursor: 'cursor-1',
        hasMore: false,
      },
      { previousCursor: 'cursor-0', events: [], nextCursor: 'cursor-0', hasMore: 'false' },
      { previousCursor: 'cursor-0', events: [], nextCursor: 'cursor-other', hasMore: false },
      { previousCursor: 'cursor-0', events: [], nextCursor: 'cursor-0', hasMore: true },
      {
        previousCursor: 'cursor-0',
        events: [sharedInvite, { ...subscriptionInvite, eventId: '55555555-5555-4555-8555-555555555555' }],
        nextCursor: 'cursor-1',
        hasMore: false,
      },
      { previousCursor: 'cursor-0', events: [sharedInvite], nextCursor: 'cursor-other', hasMore: false },
      ...malformedEvents.map(replayWith),
    ]
    let replayIndex = 0
    const readAfter = vi.fn(async () => malformedReplays[replayIndex++] as never)
    const inviteEvents: SyncInviteEventsAdapter = {
      distribution: 'shared',
      ready: () => true,
      tail: vi.fn(async () => 'cursor-tail'),
      readAfter,
      subscribeAvailability: vi.fn(() => () => undefined),
    }
    const { handler, socket } = await authenticatedHandler({ inviteEvents, requireSharedState: true })

    for (const [index] of malformedReplays.entries()) {
      enqueue(handler, inviteSubscribeFrame(index + 1, 'cursor-0', 2))
      await vi.waitFor(() => expect(readAfter).toHaveBeenCalledTimes(index + 1))
      await vi.waitFor(() => expect(socket.frames.filter((frame) => frame.type === 'ERROR')).toHaveLength(index + 1))
      expect(socket.frames.at(-1)?.payload).toMatchObject({ code: 'INVITE_STORE_UNAVAILABLE' })
    }

    expect(socket.frames.some((frame) => frame.type === 'INVITE_BATCH')).toBe(false)
    handler.disconnect()
  })

  it('requires authoritative bootstrap before subscribing and fails closed on an invalid invite ACK', async () => {
    const listeners = new Set<() => void>()
    const inviteEvents: SyncInviteEventsAdapter = {
      distribution: 'shared',
      ready: () => true,
      tail: vi.fn(async () => 'cursor-tail'),
      readAfter: vi.fn(async (_userUuid, cursor) => ({
        previousCursor: cursor,
        events: [
          {
            version: 1,
            eventId: '11111111-1111-4111-8111-111111111111',
            streamPosition: 'cursor-1',
            kind: 'subscription-invite',
            action: 'created',
            inviteUuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            occurredAt: 1,
          },
        ],
        nextCursor: 'cursor-1',
        hasMore: false,
      })),
      subscribeAvailability: vi.fn((_userUuid, listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }),
    }
    const bootstrap = await authenticatedHandler({ inviteEvents, requireSharedState: true })
    enqueue(bootstrap.handler, inviteSubscribeFrame(1))
    await vi.waitFor(() => expect(bootstrap.socket.frames.at(-1)?.type).toBe('INVITE_RECONCILE'))
    expect(bootstrap.socket.frames.at(-1)?.payload).toEqual({
      reason: 'BOOTSTRAP_REQUIRED',
      cursor: 'cursor-tail',
    })
    expect(inviteEvents.readAfter).not.toHaveBeenCalled()
    expect(inviteEvents.subscribeAvailability).not.toHaveBeenCalled()

    const invalidAck = await authenticatedHandler({ inviteEvents, requireSharedState: true })
    enqueue(invalidAck.handler, inviteSubscribeFrame(1, 'cursor-0'))
    await vi.waitFor(() => expect(invalidAck.socket.frames.at(-1)?.type).toBe('INVITE_BATCH'))
    enqueue(invalidAck.handler, inviteAckFrame(2, 'cursor-wrong'))
    await vi.waitFor(() => expect(invalidAck.socket.closes).toHaveLength(1))
    expect(invalidAck.socket.frames.at(-1)?.payload).toMatchObject({ code: 'INVITE_ACK_INVALID' })
    expect(listeners.size).toBe(0)

    bootstrap.handler.disconnect()
  })

  it('enforces the first-frame auth deadline', async () => {
    const socket = new FakeSocket()
    const metrics = { increment: vi.fn() }
    new SyncCommandHandler({
      socket,
      ownerId: 'owner',
      tickets: new InMemorySyncAuthTicketStore(),
      leases: new InMemorySyncCommandLeaseRegistry(),
      socketBudget: new InMemorySyncSocketBudget(),
      authorization: allowAuthorization(),
      backend: committingBackend(),
      isEnabled: () => true,
      authDeadlineMs: 5,
      metrics,
    })

    await vi.waitFor(() => expect(socket.closes.at(-1)?.code).toBe(1008))
    expect(socket.frames.at(-1)?.payload).toEqual({ code: 'AUTH_TIMEOUT', retryable: false })
    expect(metrics.increment).toHaveBeenCalledWith('auth', 'timeout')
  })

  it('rejects non-AUTH first frames, malformed frames, and disabled adapters', async () => {
    const build = (isEnabled = true, authorization = allowAuthorization()) => {
      const socket = new FakeSocket()
      const handler = new SyncCommandHandler({
        socket,
        ownerId: 'owner',
        tickets: new InMemorySyncAuthTicketStore(),
        leases: new InMemorySyncCommandLeaseRegistry(),
        socketBudget: new InMemorySyncSocketBudget(),
        authorization,
        backend: committingBackend(),
        isEnabled: () => isEnabled,
      })
      return { socket, handler }
    }

    const authRequired = build()
    enqueue(authRequired.handler, pingFrame(0))
    await vi.waitFor(() =>
      expect(authRequired.socket.frames.at(-1)?.payload).toEqual({ code: 'AUTH_REQUIRED', retryable: false }),
    )

    const malformed = build()
    malformed.handler.enqueue('{', 1)
    await vi.waitFor(() =>
      expect(malformed.socket.frames.at(-1)?.payload).toEqual({ code: 'MALFORMED_JSON', retryable: false }),
    )

    const disabled = build(false)
    enqueue(disabled.handler, pingFrame(0))
    await vi.waitFor(() => expect(disabled.socket.closes.at(-1)?.code).toBe(1012))
    expect(disabled.socket.frames.at(-1)?.payload).toEqual({ code: 'SYNC_DISABLED', retryable: true })

    const adapterNotReady = build(true, { ready: () => false, authorize: vi.fn() })
    enqueue(adapterNotReady.handler, pingFrame(0))
    await vi.waitFor(() => expect(adapterNotReady.socket.closes.at(-1)?.code).toBe(1012))
  })

  it('fails over with a retryable signal when shared authentication state disappears mid-frame', async () => {
    const socket = new FakeSocket()
    const handler = new SyncCommandHandler({
      socket,
      ownerId: 'owner',
      tickets: {
        distribution: 'shared',
        ready: () => true,
        issue: vi.fn(async () => {
          throw new Error('not used')
        }),
        consume: vi.fn(async () => {
          throw new Error('redis outage')
        }),
      },
      leases: new InMemorySyncCommandLeaseRegistry(),
      socketBudget: new InMemorySyncSocketBudget(),
      authorization: allowAuthorization(),
      backend: committingBackend(),
      isEnabled: () => true,
    })
    enqueue(handler, authFrame('x'.repeat(43)))
    await vi.waitFor(() => expect(socket.closes.at(-1)?.code).toBe(1013))
    expect(socket.frames.at(-1)?.payload).toEqual({ code: 'SYNC_DISABLED', retryable: true })
    await handler.stop()
  })

  it('bounds queued input and ignores work after closure', async () => {
    const socket = new FakeSocket()
    const handler = new SyncCommandHandler({
      socket,
      ownerId: 'owner',
      tickets: new InMemorySyncAuthTicketStore(),
      leases: new InMemorySyncCommandLeaseRegistry(),
      socketBudget: new InMemorySyncSocketBudget(),
      authorization: allowAuthorization(),
      backend: committingBackend(),
      isEnabled: () => true,
      maxQueuedFrames: 1,
    })
    handler.enqueue('{}', -1)
    await vi.waitFor(() => expect(socket.closes.at(-1)?.code).toBe(1013))
    const frameCount = socket.frames.length
    handler.enqueue('{}', 2)
    handler.disconnect()
    expect(socket.frames).toHaveLength(frameCount)
  })

  it('authenticates once and emits the frozen ACCEPTED then COMMITTED payloads', async () => {
    const { handler, socket } = await authenticatedHandler()
    const command = commandFrame('command-1', 1)
    enqueue(handler, command)

    await vi.waitFor(() => expect(socket.frames.map((frame) => frame.type)).toContain('COMMITTED'))
    expect(socket.frames[0].payload).toEqual({
      capability: 'ws-sync',
      protocolVersion: 1,
      operations: ['SYNC_ITEMS'],
      nextClientSequence: 1,
    })
    expect(socket.frames[1]).toMatchObject({
      type: 'ACCEPTED',
      digest: command.digest,
      payload: { status: 'ACCEPTED' },
    })
    expect(socket.frames[2]).toMatchObject({
      type: 'COMMITTED',
      digest: command.digest,
      payload: { status: 'COMMITTED', result: { saved: true } },
    })
    handler.disconnect()
  })

  // -------------------------------------------------------------------------
  // SYNC_ITEMS is the ONLY capability that depends on the durable command
  // backend. These cover the socket that opens without it: every other lane
  // negotiates normally and the client syncs over HTTP, instead of the whole
  // socket closing and dropping five gRPC-independent capabilities with it.
  // -------------------------------------------------------------------------
  const unreadyBackend = (): SyncCommandBackendAdapter => ({
    ready: () => false,
    execute: vi.fn<SyncCommandBackendAdapter['execute']>(async () => {
      throw new Error('the durable backend must never be entered when it is unready')
    }),
    status: vi.fn<SyncCommandBackendAdapter['status']>(async () => {
      throw new Error('the durable backend must never be entered when it is unready')
    }),
  })

  it('withholds SYNC_ITEMS when the durable backend is unready, and still negotiates the rest', async () => {
    const apiRpc: SyncApiRpcAdapter = {
      idempotencyScope: 'shared-durable',
      ready: () => true,
      operations: () => ['API_RPC', 'STREAM_ASSISTANT'],
      execute: vi.fn(),
    }
    const collaborationAuthorization = {
      collaborationAuthorizationReady: () => true,
      authorizeCollaboration: vi.fn(),
    } as unknown as SyncCollaborationAuthorizationAdapter

    const { handler, socket } = await authenticatedHandler({
      backend: unreadyBackend(),
      apiRpc,
      collaborationAuthorization,
    })

    expect(socket.frames[0].type).toBe('AUTHENTICATED')
    expect(socket.frames[0].payload).toEqual({
      capability: 'ws-sync',
      protocolVersion: 1,
      operations: ['AUTHORIZE_COLLABORATION', 'API_RPC', 'STREAM_ASSISTANT'],
      nextClientSequence: 1,
    })
    expect(socket.closes).toHaveLength(0)
    handler.disconnect()
  })

  it('keeps the advertised list byte-identical when the durable backend IS ready', async () => {
    // The protection for every deployment NOT affected by this change: making
    // SYNC_ITEMS conditional must not reorder or drop anything when the durable
    // port is bound, which is the state a gRPC-configured gateway runs in.
    const apiRpc: SyncApiRpcAdapter = {
      idempotencyScope: 'shared-durable',
      ready: () => true,
      operations: () => ['API_RPC', 'STREAM_ASSISTANT'],
      execute: vi.fn(),
    }
    const collaborationAuthorization = {
      collaborationAuthorizationReady: () => true,
      authorizeCollaboration: vi.fn(),
    } as unknown as SyncCollaborationAuthorizationAdapter

    const { handler, socket } = await authenticatedHandler({ apiRpc, collaborationAuthorization })

    expect(socket.frames[0].payload).toEqual({
      capability: 'ws-sync',
      protocolVersion: 1,
      operations: ['SYNC_ITEMS', 'AUTHORIZE_COLLABORATION', 'API_RPC', 'STREAM_ASSISTANT'],
      nextClientSequence: 1,
    })
    handler.disconnect()
  })

  it('refuses a COMMAND with OPERATION_UNAVAILABLE without taking a lease or closing the socket', async () => {
    const leases = new InMemorySyncCommandLeaseRegistry()
    const acquire = vi.spyOn(leases, 'acquire')
    const backend = unreadyBackend()
    const { handler, socket } = await authenticatedHandler({ backend, leases })

    enqueue(handler, commandFrame('command-1', 1))

    await vi.waitFor(() => expect(socket.frames.map((frame) => frame.type)).toContain('ERROR'))
    expect(socket.frames.at(-1)?.payload).toEqual({ code: 'OPERATION_UNAVAILABLE', retryable: true })
    // A socket that never advertised SYNC_ITEMS must not be able to reserve
    // durable-command leases, so the refusal precedes lease acquisition.
    expect(acquire).not.toHaveBeenCalled()
    expect(backend.execute).not.toHaveBeenCalled()
    // Non-fatal: the invite, collaboration, RPC and files lanes stay usable.
    expect(socket.closes).toHaveLength(0)
    handler.disconnect()
  })

  it('refuses a STATUS with OPERATION_UNAVAILABLE without entering the backend', async () => {
    const backend = unreadyBackend()
    const { handler, socket } = await authenticatedHandler({ backend })

    enqueue(handler, statusFrame('command-1', 1, 'a'.repeat(64)))

    await vi.waitFor(() => expect(socket.frames.map((frame) => frame.type)).toContain('ERROR'))
    expect(socket.frames.at(-1)?.payload).toEqual({ code: 'OPERATION_UNAVAILABLE', retryable: true })
    expect(backend.status).not.toHaveBeenCalled()
    expect(socket.closes).toHaveLength(0)
    handler.disconnect()
  })

  it('discovers an opaque epoch without a capability, then grants once for the exact one-use challenge', async () => {
    const roomEpoch = 'room_epoch_00000001'
    const securityEpoch = 'security_epoch_0001'
    const authorizeCollaboration = vi.fn<SyncCollaborationAuthorizationAdapter['authorizeCollaboration']>(
      async ({ request }) =>
        request.epochDiscovery === true
          ? {
              authorized: true,
              epochDiscovery: true,
              room: request.noteUuid,
              serverUpdatedAtTimestamp: 123,
              collaborationProtocolVersion: 3,
              roomEpoch,
              collaborationSecurityEpoch: securityEpoch,
            }
          : {
              authorized: true,
              capability: 'collaboration-capability',
              room: request.noteUuid,
              expiresIn: 300,
              serverUpdatedAtTimestamp: 123,
              collaborationProtocolVersion: 3,
              roomEpoch,
              collaborationSecurityEpoch: securityEpoch,
              // SyncCollaborationAuthorizationPayload is `JsonObject & (union)`, so an
              // unnarrowed read lands on the index signature and yields unknown.
              // Narrow at runtime rather than assert: a string still echoes back
              // unchanged, which is what this test asserts on the granted frame.
              leaseRequestId: optionalString(request.leaseRequestId),
              bootstrapChallenge: optionalString(request.bootstrapChallenge),
            },
    )
    const collaborationAuthorization: SyncCollaborationAuthorizationAdapter = {
      collaborationAuthorizationReady: () => true,
      authorizeCollaboration,
    }
    const { handler, socket } = await authenticatedHandler({ collaborationAuthorization })
    enqueue(
      handler,
      collaborationAuthorizationFrame(1, {
        noteUuid: 'note-1',
        collaborationProtocolVersion: 3,
        epochDiscovery: true,
      }),
    )

    await vi.waitFor(() => expect(socket.frames.at(-1)?.type).toBe('COLLABORATION_AUTHORIZED'))
    const discovery = socket.frames.at(-1) as JsonObject
    expect(discovery.payload).toMatchObject({
      epochDiscovery: true,
      room: 'note-1',
      collaborationProtocolVersion: 3,
      roomEpoch,
      collaborationSecurityEpoch: securityEpoch,
      epochDiscoveryRequestId: 'collaboration-request-1',
      epochDiscoveryChallenge: expect.any(String),
      challengeExpiresAt: expect.any(Number),
    })
    expect(discovery.payload).not.toHaveProperty('capability')
    expect(discovery.payload).not.toHaveProperty('expiresIn')
    expect(socket.frames.some((frame) => String(frame.type).startsWith('ROOM_'))).toBe(false)
    expect(authorizeCollaboration).toHaveBeenCalledTimes(1)

    const grantPayload = {
      noteUuid: 'note-1',
      collaborationProtocolVersion: 3,
      expectedRoomEpoch: roomEpoch,
      epochDiscoveryChallenge: payloadOf(discovery).epochDiscoveryChallenge,
      epochDiscoveryRequestId: payloadOf(discovery).epochDiscoveryRequestId,
      leaseRequestId: 'lease-1',
      bootstrapChallenge: 'challenge-1',
    }
    enqueue(handler, collaborationAuthorizationFrame(2, grantPayload))
    await vi.waitFor(() =>
      expect(socket.frames.at(-1)?.payload).toMatchObject({ capability: 'collaboration-capability' }),
    )
    expect(socket.frames.at(-1)?.payload).toEqual({
      capability: 'collaboration-capability',
      room: 'note-1',
      expiresIn: 300,
      serverUpdatedAtTimestamp: 123,
      collaborationProtocolVersion: 3,
      roomEpoch,
      collaborationSecurityEpoch: securityEpoch,
      leaseRequestId: 'lease-1',
      bootstrapChallenge: 'challenge-1',
    })
    expect(authorizeCollaboration).toHaveBeenCalledTimes(2)

    enqueue(handler, collaborationAuthorizationFrame(3, grantPayload))
    await vi.waitFor(() => expect(socket.frames.at(-1)?.payload).toEqual({ code: 'NOT_AUTHORIZED', retryable: false }))
    expect(authorizeCollaboration).toHaveBeenCalledTimes(2)
    handler.disconnect()
  })

  it('consumes a discovery challenge even when the first exact grant attempt mismatches', async () => {
    const authorizeCollaboration = vi.fn(async () => ({
      authorized: true as const,
      epochDiscovery: true as const,
      room: 'note-1',
      serverUpdatedAtTimestamp: 123,
      collaborationProtocolVersion: 3 as const,
      roomEpoch: 'room_epoch_00000001',
      collaborationSecurityEpoch: 'security_epoch_0001',
    }))
    const { handler, socket } = await authenticatedHandler({
      collaborationAuthorization: { collaborationAuthorizationReady: () => true, authorizeCollaboration },
    })
    enqueue(
      handler,
      collaborationAuthorizationFrame(1, {
        noteUuid: 'note-1',
        collaborationProtocolVersion: 3,
        epochDiscovery: true,
      }),
    )
    await vi.waitFor(() => expect(socket.frames.at(-1)?.type).toBe('COLLABORATION_AUTHORIZED'))
    const discovery = socket.frames.at(-1) as JsonObject
    const grant = {
      noteUuid: 'note-1',
      collaborationProtocolVersion: 3,
      expectedRoomEpoch: 'room_epoch_00000001',
      epochDiscoveryRequestId: payloadOf(discovery).epochDiscoveryRequestId,
      epochDiscoveryChallenge: 'wrong_challenge_abcdefghijklmnopqrstuvwxyz',
    }

    enqueue(handler, collaborationAuthorizationFrame(2, grant))
    await vi.waitFor(() => expect(socket.frames.at(-1)?.payload).toEqual({ code: 'NOT_AUTHORIZED', retryable: false }))
    enqueue(
      handler,
      collaborationAuthorizationFrame(3, {
        ...grant,
        epochDiscoveryChallenge: payloadOf(discovery).epochDiscoveryChallenge,
      }),
    )
    await vi.waitFor(() => expect(socket.frames.filter((frame) => frame.type === 'ERROR')).toHaveLength(2))
    expect(authorizeCollaboration).toHaveBeenCalledTimes(1)
    handler.disconnect()
  })

  it('rejects an expired discovery challenge before invoking the grant backend', async () => {
    let now = 1_000_000
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    const authorizeCollaboration = vi.fn(async () => ({
      authorized: true as const,
      epochDiscovery: true as const,
      room: 'note-1',
      serverUpdatedAtTimestamp: 123,
      collaborationProtocolVersion: 3 as const,
      roomEpoch: 'room_epoch_00000001',
      collaborationSecurityEpoch: 'security_epoch_0001',
    }))
    const { handler, socket } = await authenticatedHandler({
      collaborationAuthorization: { collaborationAuthorizationReady: () => true, authorizeCollaboration },
    })
    try {
      enqueue(handler, collaborationAuthorizationFrame(1))
      await vi.waitFor(() => expect(socket.frames.at(-1)?.type).toBe('COLLABORATION_AUTHORIZED'))
      const discovery = socket.frames.at(-1) as JsonObject
      now += 10_001
      enqueue(
        handler,
        collaborationAuthorizationFrame(2, {
          noteUuid: 'note-1',
          collaborationProtocolVersion: 3,
          expectedRoomEpoch: 'room_epoch_00000001',
          epochDiscoveryRequestId: payloadOf(discovery).epochDiscoveryRequestId,
          epochDiscoveryChallenge: payloadOf(discovery).epochDiscoveryChallenge,
        }),
      )
      await vi.waitFor(() =>
        expect(socket.frames.at(-1)?.payload).toEqual({ code: 'NOT_AUTHORIZED', retryable: false }),
      )
      expect(authorizeCollaboration).toHaveBeenCalledTimes(1)
    } finally {
      handler.disconnect()
      nowSpy.mockRestore()
    }
  })

  // -------------------------------------------------------------------------
  // v3 epoch-discovery challenge handling, asserted at the GRANT BACKEND
  // boundary. `authorizeCollaboration` is the only door to the collaboration
  // capability minter, so every case below asserts on its call count: a
  // NOT_AUTHORIZED response with the backend already invoked would mean an
  // unauthenticated challenge still reached the grant path.
  // -------------------------------------------------------------------------
  const collaborationEpochs = { roomEpoch: 'room_epoch_00000001', securityEpoch: 'security_epoch_0001' }
  // Mirrors IDENTIFIER_PATTERN in src/syncProtocol.ts, which every requestId,
  // commandId and epoch-discovery challenge on the wire must satisfy.
  const SYNC_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u

  function twoPhaseCollaborationAdapter(epochs = collaborationEpochs) {
    const authorizeCollaboration = vi.fn(
      async ({ request }: Parameters<SyncCollaborationAuthorizationAdapter['authorizeCollaboration']>[0]) =>
        request.epochDiscovery === true
          ? {
              authorized: true as const,
              epochDiscovery: true as const,
              room: request.noteUuid,
              serverUpdatedAtTimestamp: 123,
              collaborationProtocolVersion: 3 as const,
              roomEpoch: epochs.roomEpoch,
              collaborationSecurityEpoch: epochs.securityEpoch,
            }
          : {
              authorized: true as const,
              capability: 'collaboration-capability',
              room: request.noteUuid,
              expiresIn: 300,
              serverUpdatedAtTimestamp: 123,
              collaborationProtocolVersion: 3 as const,
              roomEpoch: epochs.roomEpoch,
              collaborationSecurityEpoch: epochs.securityEpoch,
              ...(typeof request.leaseRequestId === 'string' ? { leaseRequestId: request.leaseRequestId } : {}),
              ...(typeof request.bootstrapChallenge === 'string'
                ? { bootstrapChallenge: request.bootstrapChallenge }
                : {}),
            },
    )
    const adapter: SyncCollaborationAuthorizationAdapter = {
      collaborationAuthorizationReady: () => true,
      authorizeCollaboration,
    }
    return { adapter, authorizeCollaboration }
  }

  // These waits are keyed on frame COUNTS rather than "the last frame", so they
  // are independent of unrelated frames arriving in between. The short poll
  // interval matters: each handshake step costs one poll, and the default 50ms
  // interval makes a four-step test spend most of its budget sleeping once the
  // whole suite is competing for the event loop.
  const FRAME_WAIT = { timeout: 15_000, interval: 5 }
  /** Generous per-test budget; these tests take tens of milliseconds unloaded. */
  const CHALLENGE_TEST_TIMEOUT = 30_000

  async function discover(
    handler: SyncCommandHandler,
    socket: FakeSocket,
    sequence: number,
    noteUuid = 'note-1',
  ): Promise<{ epochDiscoveryChallenge: string; epochDiscoveryRequestId: string }> {
    const before = socket.frames.filter((frame) => frame.type === 'COLLABORATION_AUTHORIZED').length
    enqueue(
      handler,
      collaborationAuthorizationFrame(sequence, {
        noteUuid,
        collaborationProtocolVersion: 3,
        epochDiscovery: true,
      }),
    )
    let payload: JsonObject | undefined
    await vi.waitFor(() => {
      const granted = socket.frames.filter((frame) => frame.type === 'COLLABORATION_AUTHORIZED')
      expect(granted).toHaveLength(before + 1)
      payload = granted.at(-1)?.payload as JsonObject
      expect(payload.epochDiscovery).toBe(true)
    }, FRAME_WAIT)
    const epochDiscoveryChallenge = (payload as JsonObject).epochDiscoveryChallenge as string
    // A challenge the client cannot echo back is unusable. See the dedicated
    // regression test below: the minter emits base64url, whose leading `_`/`-`
    // the envelope identifier validator rejects.
    expect(
      SYNC_IDENTIFIER_PATTERN.test(epochDiscoveryChallenge),
      `minted challenge "${epochDiscoveryChallenge}" is not a valid protocol identifier, so the client can never present it`,
    ).toBe(true)
    return {
      epochDiscoveryChallenge,
      epochDiscoveryRequestId: (payload as JsonObject).epochDiscoveryRequestId as string,
    }
  }

  /** Wait until exactly `count` ERROR frames exist, the newest being a denial. */
  async function expectDenials(socket: FakeSocket, count: number): Promise<void> {
    await vi.waitFor(() => {
      const errors = socket.frames.filter((frame) => frame.type === 'ERROR')
      expect(errors).toHaveLength(count)
      expect(errors.at(-1)?.payload).toEqual({ code: 'NOT_AUTHORIZED', retryable: false })
    }, FRAME_WAIT)
  }

  /** Wait until exactly `count` capability grants have been issued. */
  async function expectGrants(socket: FakeSocket, count: number): Promise<void> {
    await vi.waitFor(() => {
      const granted = socket.frames.filter(
        (frame) => frame.type === 'COLLABORATION_AUTHORIZED' && (frame.payload as JsonObject).capability !== undefined,
      )
      expect(granted).toHaveLength(count)
      expect(granted.at(-1)?.payload).toMatchObject({ capability: 'collaboration-capability' })
    }, FRAME_WAIT)
  }

  /** Protocol error code the wire parser rejects a challenge echo with, if any. */
  function echoRejectionCode(challenge: string): string | undefined {
    const frame = collaborationAuthorizationFrame(1, {
      noteUuid: 'note-1',
      collaborationProtocolVersion: 3,
      expectedRoomEpoch: collaborationEpochs.roomEpoch,
      epochDiscoveryChallenge: challenge,
      epochDiscoveryRequestId: 'collaboration-request-1',
    })
    try {
      parseSyncClientFrame(rawFrame(frame))
      return undefined
    } catch (error) {
      return (error as { code?: string }).code
    }
  }

  // REGRESSION. The one-use challenge is minted by the server and echoed back
  // verbatim by the client, so it must satisfy IDENTIFIER_PATTERN in
  // src/syncProtocol.ts, whose FIRST character must be alphanumeric.
  //
  // It was minted as `randomBytes(32).toString('base64url')`, which leads with
  // `-` or `_` 2/64 = 3.125% of the time. Those challenges could never be
  // presented: the echo failed envelope validation and failAndClose() tore down
  // the WHOLE sync socket with close code 1008, taking sync, files and invite
  // streams with it — not just the collaboration request. It failed closed (no
  // unauthorized grant), so the defect was availability, not authorization.
  it('mints an epoch-discovery challenge the client can actually present', { timeout: 30_000 }, async () => {
    // The trap, pinned deterministically: these are exactly the bytes
    // randomBytes yields when the first six random bits are set.
    const unpresentable = Buffer.alloc(32, 0xfc).toString('base64url')
    expect(unpresentable.startsWith('_')).toBe(true)
    expect(SYNC_IDENTIFIER_PATTERN.test(unpresentable)).toBe(false)
    expect(echoRejectionCode(unpresentable)).toBe('INVALID_ENVELOPE')

    // The same bytes under the encoding the minter now uses.
    const presentable = Buffer.alloc(32, 0xfc).toString('hex')
    expect(SYNC_IDENTIFIER_PATTERN.test(presentable)).toBe(true)
    expect(echoRejectionCode(presentable)).toBeUndefined()

    // And end to end against the real minter: whatever the handler hands out
    // must survive the envelope check on the way back in. `discover()` already
    // asserts the pattern; this pins the actual round trip.
    const { adapter } = twoPhaseCollaborationAdapter()
    const { handler, socket } = await authenticatedHandler({ collaborationAuthorization: adapter })
    try {
      for (let attempt = 1; attempt <= 8; attempt += 1) {
        const { epochDiscoveryChallenge } = await discover(handler, socket, attempt)
        expect(epochDiscoveryChallenge).toMatch(/^[0-9a-f]{64}$/)
        expect(echoRejectionCode(epochDiscoveryChallenge)).toBeUndefined()
      }
    } finally {
      handler.disconnect()
    }
  })

  it(
    'MISSING challenge: a grant request with no prior discovery never reaches the grant backend',
    { timeout: CHALLENGE_TEST_TIMEOUT },
    async () => {
      const metrics: SyncCommandMetrics = { increment: vi.fn() }
      const { adapter, authorizeCollaboration } = twoPhaseCollaborationAdapter()
      const { handler, socket } = await authenticatedHandler({ collaborationAuthorization: adapter, metrics })

      // Well-formed on the wire, but this socket never performed epoch discovery.
      enqueue(
        handler,
        collaborationAuthorizationFrame(1, {
          noteUuid: 'note-1',
          collaborationProtocolVersion: 3,
          expectedRoomEpoch: collaborationEpochs.roomEpoch,
          epochDiscoveryChallenge: 'fabricated_challenge_abcdefghijklmnop',
          epochDiscoveryRequestId: 'fabricated-request',
          leaseRequestId: 'lease-1',
        }),
      )

      await expectDenials(socket, 1)
      expect(authorizeCollaboration).not.toHaveBeenCalled()
      expect(metrics.increment).toHaveBeenCalledWith('collaboration_authorization', 'epoch_challenge_invalid')
      expect(socket.frames.some((frame) => frame.type === 'COLLABORATION_AUTHORIZED')).toBe(false)

      // Control: this exact spy DOES record a call once the handshake is real, so
      // the zero-call assertion above is not vacuous.
      const challenge = await discover(handler, socket, 2)
      enqueue(
        handler,
        collaborationAuthorizationFrame(3, {
          noteUuid: 'note-1',
          collaborationProtocolVersion: 3,
          expectedRoomEpoch: collaborationEpochs.roomEpoch,
          leaseRequestId: 'lease-1',
          ...challenge,
        }),
      )
      await expectGrants(socket, 1)
      expect(authorizeCollaboration).toHaveBeenCalledTimes(2)
      handler.disconnect()
    },
  )

  it(
    'MISSING challenge: a grant frame omitting the challenge fields is rejected at the envelope',
    { timeout: CHALLENGE_TEST_TIMEOUT },
    async () => {
      const { adapter, authorizeCollaboration } = twoPhaseCollaborationAdapter()
      const { handler, socket } = await authenticatedHandler({ collaborationAuthorization: adapter })
      await discover(handler, socket, 1)
      expect(authorizeCollaboration).toHaveBeenCalledTimes(1)

      enqueue(
        handler,
        collaborationAuthorizationFrame(2, {
          noteUuid: 'note-1',
          collaborationProtocolVersion: 3,
          expectedRoomEpoch: collaborationEpochs.roomEpoch,
          leaseRequestId: 'lease-1',
        }),
      )

      await vi.waitFor(() => expect(socket.closes).toHaveLength(1), FRAME_WAIT)
      expect(socket.frames.at(-1)?.payload).toEqual({ code: 'INVALID_ENVELOPE', retryable: false })
      expect(socket.closes[0].code).toBe(1008)
      // The discovery call is the only one; the grant backend was never reached.
      expect(authorizeCollaboration).toHaveBeenCalledTimes(1)
      handler.disconnect()
    },
  )

  it.each([
    [
      'another note',
      (challenge: { epochDiscoveryChallenge: string; epochDiscoveryRequestId: string }) => ({
        noteUuid: 'note-2',
        collaborationProtocolVersion: 3,
        expectedRoomEpoch: collaborationEpochs.roomEpoch,
        ...challenge,
      }),
    ],
    [
      'another room epoch',
      (challenge: { epochDiscoveryChallenge: string; epochDiscoveryRequestId: string }) => ({
        noteUuid: 'note-1',
        collaborationProtocolVersion: 3,
        expectedRoomEpoch: 'room_epoch_00000002',
        ...challenge,
      }),
    ],
    [
      'another discovery request id',
      (challenge: { epochDiscoveryChallenge: string; epochDiscoveryRequestId: string }) => ({
        noteUuid: 'note-1',
        collaborationProtocolVersion: 3,
        expectedRoomEpoch: collaborationEpochs.roomEpoch,
        epochDiscoveryChallenge: challenge.epochDiscoveryChallenge,
        epochDiscoveryRequestId: 'some-other-discovery',
      }),
    ],
    [
      'a challenge value from nowhere',
      (challenge: { epochDiscoveryChallenge: string; epochDiscoveryRequestId: string }) => ({
        noteUuid: 'note-1',
        collaborationProtocolVersion: 3,
        expectedRoomEpoch: collaborationEpochs.roomEpoch,
        epochDiscoveryChallenge: 'unrelated_challenge_abcdefghijklmnop',
        epochDiscoveryRequestId: challenge.epochDiscoveryRequestId,
      }),
    ],
  ])(
    'MISMATCHED challenge bound to %s never reaches the grant backend',
    { timeout: CHALLENGE_TEST_TIMEOUT },
    async (_description, buildGrant) => {
      const { adapter, authorizeCollaboration } = twoPhaseCollaborationAdapter()
      const { handler, socket } = await authenticatedHandler({ collaborationAuthorization: adapter })
      const challenge = await discover(handler, socket, 1)
      expect(authorizeCollaboration).toHaveBeenCalledTimes(1)

      enqueue(handler, collaborationAuthorizationFrame(2, buildGrant(challenge)))

      await expectDenials(socket, 1)
      expect(authorizeCollaboration).toHaveBeenCalledTimes(1)
      expect(socket.frames.filter((frame) => frame.type === 'COLLABORATION_AUTHORIZED')).toHaveLength(1)
      handler.disconnect()
    },
  )

  it(
    'MISMATCHED challenge: a challenge issued to one socket never reaches another socket grant backend',
    { timeout: CHALLENGE_TEST_TIMEOUT },
    async () => {
      const issuer = twoPhaseCollaborationAdapter()
      const victim = twoPhaseCollaborationAdapter()
      const issuerHandler = await authenticatedHandler({ collaborationAuthorization: issuer.adapter })
      const victimHandler = await authenticatedHandler({ collaborationAuthorization: victim.adapter })
      const challenge = await discover(issuerHandler.handler, issuerHandler.socket, 1)
      expect(victim.authorizeCollaboration).not.toHaveBeenCalled()

      enqueue(
        victimHandler.handler,
        collaborationAuthorizationFrame(1, {
          noteUuid: 'note-1',
          collaborationProtocolVersion: 3,
          expectedRoomEpoch: collaborationEpochs.roomEpoch,
          ...challenge,
        }),
      )

      await expectDenials(victimHandler.socket, 1)
      // The challenge is bound to the socket that discovered it; the second
      // socket's grant backend is never consulted.
      expect(victim.authorizeCollaboration).not.toHaveBeenCalled()
      expect(issuer.authorizeCollaboration).toHaveBeenCalledTimes(1)

      // Control: the second socket's own discovery does reach its own backend.
      await discover(victimHandler.handler, victimHandler.socket, 2)
      expect(victim.authorizeCollaboration).toHaveBeenCalledTimes(1)
      issuerHandler.handler.disconnect()
      victimHandler.handler.disconnect()
    },
  )

  it(
    'STALE challenge: a superseded discovery challenge never reaches the grant backend',
    { timeout: CHALLENGE_TEST_TIMEOUT },
    async () => {
      const { adapter, authorizeCollaboration } = twoPhaseCollaborationAdapter()
      const { handler, socket } = await authenticatedHandler({ collaborationAuthorization: adapter })
      const first = await discover(handler, socket, 1)
      const second = await discover(handler, socket, 2)
      expect(first.epochDiscoveryChallenge).not.toBe(second.epochDiscoveryChallenge)
      expect(authorizeCollaboration).toHaveBeenCalledTimes(2)

      enqueue(
        handler,
        collaborationAuthorizationFrame(3, {
          noteUuid: 'note-1',
          collaborationProtocolVersion: 3,
          expectedRoomEpoch: collaborationEpochs.roomEpoch,
          ...first,
        }),
      )

      await expectDenials(socket, 1)
      expect(authorizeCollaboration).toHaveBeenCalledTimes(2)

      // Only ONE challenge is ever outstanding, and a failed attempt burns it.
      // The superseding challenge is therefore dead too — presenting a stale
      // challenge cannot be used to probe whether a newer one is still live.
      enqueue(
        handler,
        collaborationAuthorizationFrame(4, {
          noteUuid: 'note-1',
          collaborationProtocolVersion: 3,
          expectedRoomEpoch: collaborationEpochs.roomEpoch,
          ...second,
        }),
      )
      await expectDenials(socket, 2)
      expect(authorizeCollaboration).toHaveBeenCalledTimes(2)

      // Control: a fresh discovery still grants, so the rejections above are
      // about challenge staleness rather than a wedged handshake.
      const third = await discover(handler, socket, 5)
      enqueue(
        handler,
        collaborationAuthorizationFrame(6, {
          noteUuid: 'note-1',
          collaborationProtocolVersion: 3,
          expectedRoomEpoch: collaborationEpochs.roomEpoch,
          ...third,
        }),
      )
      await expectGrants(socket, 1)
      expect(authorizeCollaboration).toHaveBeenCalledTimes(4)
      handler.disconnect()
    },
  )

  it(
    'REPLAYED challenge: a consumed challenge cannot be rebound to a different lease request',
    { timeout: CHALLENGE_TEST_TIMEOUT },
    async () => {
      const { adapter, authorizeCollaboration } = twoPhaseCollaborationAdapter()
      const { handler, socket } = await authenticatedHandler({ collaborationAuthorization: adapter })
      const challenge = await discover(handler, socket, 1)

      enqueue(
        handler,
        collaborationAuthorizationFrame(2, {
          noteUuid: 'note-1',
          collaborationProtocolVersion: 3,
          expectedRoomEpoch: collaborationEpochs.roomEpoch,
          leaseRequestId: 'lease-1',
          ...challenge,
        }),
      )
      await expectGrants(socket, 1)
      expect(authorizeCollaboration).toHaveBeenCalledTimes(2)

      // Same one-use challenge, different lease binding: a second capability for
      // the same epoch would let one authorization mint two room leases.
      enqueue(
        handler,
        collaborationAuthorizationFrame(3, {
          noteUuid: 'note-1',
          collaborationProtocolVersion: 3,
          expectedRoomEpoch: collaborationEpochs.roomEpoch,
          leaseRequestId: 'lease-2',
          ...challenge,
        }),
      )

      await expectDenials(socket, 1)
      expect(authorizeCollaboration).toHaveBeenCalledTimes(2)
      expect(socket.frames.filter((frame) => frame.type === 'COLLABORATION_AUTHORIZED')).toHaveLength(2)
      handler.disconnect()
    },
  )

  it(
    'REPLAYED challenge: a rejected grant burns the challenge so a retry cannot reach the backend',
    { timeout: CHALLENGE_TEST_TIMEOUT },
    async () => {
      const { adapter, authorizeCollaboration } = twoPhaseCollaborationAdapter()
      const { handler, socket } = await authenticatedHandler({ collaborationAuthorization: adapter })
      const challenge = await discover(handler, socket, 1)

      // First attempt fails the binding check, which still consumes the challenge.
      enqueue(
        handler,
        collaborationAuthorizationFrame(2, {
          noteUuid: 'note-1',
          collaborationProtocolVersion: 3,
          expectedRoomEpoch: 'room_epoch_00000099',
          ...challenge,
        }),
      )
      await expectDenials(socket, 1)
      expect(authorizeCollaboration).toHaveBeenCalledTimes(1)

      // The now-burned challenge must not become usable again on a correct retry.
      enqueue(
        handler,
        collaborationAuthorizationFrame(3, {
          noteUuid: 'note-1',
          collaborationProtocolVersion: 3,
          expectedRoomEpoch: collaborationEpochs.roomEpoch,
          ...challenge,
        }),
      )
      await expectDenials(socket, 2)
      expect(authorizeCollaboration).toHaveBeenCalledTimes(1)
      handler.disconnect()
    },
  )

  it('fails collaboration authorization closed when unavailable, denied, malformed, or errored', async () => {
    const malformedResults = [
      { capability: 1, room: 'note-1', expiresIn: 300, serverUpdatedAtTimestamp: 123, collaborationProtocolVersion: 2 },
      {
        capability: '',
        room: 'note-1',
        expiresIn: 300,
        serverUpdatedAtTimestamp: 123,
        collaborationProtocolVersion: 2,
      },
      {
        capability: 'capability',
        room: 'note-1',
        expiresIn: 1.5,
        serverUpdatedAtTimestamp: 123,
        collaborationProtocolVersion: 2,
      },
      {
        capability: 'capability',
        room: 'note-1',
        expiresIn: 0,
        serverUpdatedAtTimestamp: 123,
        collaborationProtocolVersion: 2,
      },
      {
        capability: 'capability',
        room: 'note-1',
        expiresIn: 300,
        serverUpdatedAtTimestamp: 1.5,
        collaborationProtocolVersion: 2,
      },
      {
        capability: 'capability',
        room: 'note-1',
        expiresIn: 300,
        serverUpdatedAtTimestamp: 0,
        collaborationProtocolVersion: 2,
      },
      {
        capability: 'capability',
        room: 'note-1',
        expiresIn: 300,
        serverUpdatedAtTimestamp: 123,
        collaborationProtocolVersion: 1,
      },
      {
        capability: 'capability',
        room: 'note-1',
        expiresIn: 300,
        serverUpdatedAtTimestamp: 123,
        collaborationProtocolVersion: 2,
        leaseRequestId: 'wrong-lease',
      },
      {
        capability: 'capability',
        room: 'note-1',
        expiresIn: 300,
        serverUpdatedAtTimestamp: 123,
        collaborationProtocolVersion: 2,
        leaseRequestId: 'lease-1',
        bootstrapChallenge: 'wrong-challenge',
      },
    ]
    const cases: Array<{
      adapter?: SyncCollaborationAuthorizationAdapter
      expectedCode: string
      expectedMetric?: string
    }> = [
      { expectedCode: 'OPERATION_UNAVAILABLE' },
      {
        adapter: {
          collaborationAuthorizationReady: () => false,
          authorizeCollaboration: vi.fn(),
        },
        expectedCode: 'OPERATION_UNAVAILABLE',
      },
      {
        adapter: {
          collaborationAuthorizationReady: () => true,
          authorizeCollaboration: vi.fn<SyncCollaborationAuthorizationAdapter['authorizeCollaboration']>(async () => ({
            authorized: false,
          })),
        },
        expectedCode: 'NOT_AUTHORIZED',
      },
      {
        adapter: {
          collaborationAuthorizationReady: () => true,
          // Another misbehaving adapter, like malformedResults below: the wrong room
          // and a v2 protocol version are outside the result union on purpose, and the
          // handler must answer BACKEND_ERROR rather than trust them.
          authorizeCollaboration: vi.fn(
            async () =>
              ({
                authorized: true,
                capability: 'capability',
                room: 'wrong-note',
                expiresIn: 300,
                serverUpdatedAtTimestamp: 123,
                collaborationProtocolVersion: 2,
              }) as never,
          ),
        },
        expectedCode: 'BACKEND_ERROR',
      },
      ...malformedResults.map((result) => ({
        adapter: {
          collaborationAuthorizationReady: () => true,
          authorizeCollaboration: vi.fn(async () => ({ authorized: true, ...result }) as never),
        },
        expectedCode: 'BACKEND_ERROR',
      })),
      {
        adapter: {
          collaborationAuthorizationReady: () => true,
          authorizeCollaboration: vi.fn(async () => Promise.reject(new Error('authorization unavailable'))),
        },
        expectedCode: 'BACKEND_ERROR',
        expectedMetric: 'error',
      },
    ]

    for (const { adapter, expectedCode, expectedMetric } of cases) {
      const metrics: SyncCommandMetrics = { increment: vi.fn() }
      const active = await authenticatedHandler({ collaborationAuthorization: adapter, metrics })
      enqueue(active.handler, collaborationAuthorizationFrame(1))
      await vi.waitFor(() =>
        expect(active.socket.frames.at(-1)?.payload).toEqual({
          code: expectedCode,
          retryable: expectedCode === 'OPERATION_UNAVAILABLE' || expectedCode === 'BACKEND_ERROR',
        }),
      )
      if (expectedMetric) {
        expect(metrics.increment).toHaveBeenCalledWith('collaboration_authorization', expectedMetric)
      }
      active.handler.disconnect()
    }
  })

  it('times out collaboration authorization and records the timeout metric', async () => {
    const metrics: SyncCommandMetrics = { increment: vi.fn() }
    const collaborationAuthorization: SyncCollaborationAuthorizationAdapter = {
      collaborationAuthorizationReady: () => true,
      authorizeCollaboration: vi.fn<SyncCollaborationAuthorizationAdapter['authorizeCollaboration']>(
        () => new Promise(() => undefined),
      ),
    }
    const active = await authenticatedHandler({
      collaborationAuthorization,
      backendTimeoutMs: 5,
      metrics,
    })

    enqueue(active.handler, collaborationAuthorizationFrame(1))

    await vi.waitFor(() =>
      expect(active.socket.frames.at(-1)?.payload).toEqual({ code: 'BACKEND_TIMEOUT', retryable: true }),
    )
    expect(metrics.increment).toHaveBeenCalledWith('collaboration_authorization', 'timeout')
    await active.handler.stop()
  })

  it('negotiates authenticated API RPC and streams only when client credit is available', async () => {
    const apiRpc: SyncApiRpcAdapter = {
      idempotencyScope: 'shared-durable',
      ready: () => true,
      operations: () => ['API_RPC'],
      execute: vi.fn(async () => ({
        status: 200,
        headers: { 'content-type': 'application/octet-stream', 'set-cookie': 'must-not-cross-the-socket=1' },
        stream: (async function* () {
          yield Buffer.from('12345678')
        })(),
      })),
    }
    const { handler, socket } = await authenticatedHandler({ apiRpc })
    expect(socket.frames[0].payload).toMatchObject({ operations: ['SYNC_ITEMS', 'API_RPC'] })

    enqueue(
      handler,
      rpcFrame(1, {
        requestId: 'rpc-stream',
        path: '/v1/users/me',
        stream: true,
        initialCreditBytes: 4,
      }),
    )
    await vi.waitFor(() => expect(socket.frames.map((frame) => frame.type)).toContain('RPC_RESPONSE'))
    expect(socket.frames.map((frame) => frame.type)).not.toContain('RPC_CHUNK')

    enqueue(handler, rpcCreditFrame(2, 'rpc-stream', 8))
    await vi.waitFor(() => expect(socket.frames.at(-1)?.type).toBe('RPC_END'))
    const response = socket.frames.find((frame) => frame.type === 'RPC_RESPONSE')
    expect(response?.payload).toEqual({
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
      stream: true,
    })
    expect(socket.frames.find((frame) => frame.type === 'RPC_CHUNK')?.payload).toEqual({
      index: 0,
      bytes: Buffer.from('12345678').toString('base64'),
      byteLength: 8,
    })
    handler.disconnect()
  })

  it('aborts and fully cleans a credit-blocked RPC stream when the handler disconnects', async () => {
    let streamFinalized = false
    const apiRpc: SyncApiRpcAdapter = {
      idempotencyScope: 'shared-durable',
      ready: () => true,
      operations: () => ['API_RPC'],
      execute: vi.fn(async () => ({
        status: 200,
        stream: (async function* () {
          try {
            yield Buffer.from('blocked-on-credit')
          } finally {
            streamFinalized = true
          }
        })(),
      })),
    }
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')
    const { handler, socket } = await authenticatedHandler({ apiRpc })
    const internals = handler as unknown as {
      activeRpcs: Map<
        string,
        {
          controller: AbortController
          waiters: Set<() => void>
          deadlineTimer?: ReturnType<typeof setTimeout>
        }
      >
    }
    try {
      enqueue(
        handler,
        rpcFrame(1, {
          requestId: 'rpc-credit-blocked',
          path: '/v1/users/me',
          stream: true,
          initialCreditBytes: 1,
        }),
      )
      await vi.waitFor(() => expect(socket.frames.map((frame) => frame.type)).toContain('RPC_RESPONSE'))
      await vi.waitFor(() => expect(internals.activeRpcs.get('rpc-credit-blocked')?.waiters.size).toBe(1))
      const active = internals.activeRpcs.get('rpc-credit-blocked') as NonNullable<
        ReturnType<typeof internals.activeRpcs.get>
      >
      const framesBeforeDisconnect = socket.frames.length

      handler.disconnect()
      await handler.stop()

      expect(active.controller.signal.aborted).toBe(true)
      expect(active.waiters.size).toBe(0)
      expect(internals.activeRpcs.size).toBe(0)
      expect(streamFinalized).toBe(true)
      expect(clearTimeoutSpy).toHaveBeenCalledWith(active.deadlineTimer)
      expect(socket.frames).toHaveLength(framesBeforeDisconnect)
      expect(socket.frames.some((frame) => frame.type === 'RPC_CHUNK' || frame.type === 'RPC_END')).toBe(false)
    } finally {
      clearTimeoutSpy.mockRestore()
    }
  })

  it('keeps item sync on durable COMMAND and gates assistant streaming behind its negotiated operation', async () => {
    const apiRpc: SyncApiRpcAdapter = {
      idempotencyScope: 'shared-durable',
      ready: () => true,
      operations: () => ['API_RPC'],
      execute: vi.fn(async () => ({ status: 200, body: { ok: true } })),
    }
    const { handler, socket } = await authenticatedHandler({ apiRpc })

    enqueue(
      handler,
      rpcFrame(1, {
        requestId: 'rpc-items',
        method: 'POST',
        path: '/v1/items',
        body: { items: [] },
        idempotencyKey: 'item-write-attempt',
      }),
    )
    await vi.waitFor(() =>
      expect(socket.frames.at(-1)?.payload).toEqual({ code: 'OPERATION_UNAVAILABLE', retryable: true }),
    )
    enqueue(
      handler,
      rpcFrame(2, {
        requestId: 'rpc-assistant',
        method: 'POST',
        path: '/v1/assistant/stream',
        body: { prompt: 'hi' },
        stream: true,
        idempotencyKey: 'assistant-attempt',
      }),
    )
    await vi.waitFor(() =>
      expect(socket.frames.at(-1)?.payload).toEqual({ code: 'OPERATION_UNAVAILABLE', retryable: true }),
    )
    expect(apiRpc.execute).not.toHaveBeenCalled()
    handler.disconnect()
  })

  it('rejects arbitrary mutating RPC routes even when they carry an idempotency key', async () => {
    const apiRpc: SyncApiRpcAdapter = {
      idempotencyScope: 'shared-durable',
      ready: () => true,
      operations: () => ['API_RPC', 'STREAM_ASSISTANT'],
      execute: vi.fn(async () => ({ status: 200, body: { shouldNotRun: true } })),
    }
    const { handler, socket } = await authenticatedHandler({ apiRpc })

    enqueue(
      handler,
      rpcFrame(1, {
        method: 'POST',
        path: '/v1/workflows/status',
        body: { enabled: true },
        idempotencyKey: 'arbitrary-mutation-attempt',
      }),
    )

    await vi.waitFor(() =>
      expect(socket.frames.at(-1)?.payload).toEqual({ code: 'OPERATION_UNAVAILABLE', retryable: true }),
    )
    expect(apiRpc.execute).not.toHaveBeenCalled()
    handler.disconnect()
  })

  it('fails closed for unavailable adapters, file reads, unsupported verbs, and unkeyed reviewed writes', async () => {
    const unavailableAdapters: Array<SyncApiRpcAdapter | undefined> = [
      undefined,
      {
        idempotencyScope: 'shared-durable',
        ready: () => false,
        operations: () => ['API_RPC'],
        execute: vi.fn(),
      },
      {
        idempotencyScope: 'shared-durable',
        ready: () => true,
        operations: () => ['STREAM_ASSISTANT'],
        execute: vi.fn(),
      },
    ]
    for (const apiRpc of unavailableAdapters) {
      const unavailable = await authenticatedHandler({ apiRpc })
      enqueue(unavailable.handler, rpcFrame(1))
      await vi.waitFor(() =>
        expect(unavailable.socket.frames.at(-1)?.payload).toEqual({
          code: 'OPERATION_UNAVAILABLE',
          retryable: true,
        }),
      )
      unavailable.handler.disconnect()
    }

    const apiRpc: SyncApiRpcAdapter = {
      idempotencyScope: 'shared-durable',
      ready: () => true,
      operations: () => ['API_RPC', 'STREAM_ASSISTANT'],
      execute: vi.fn(async () => ({ status: 200, body: { shouldNotRun: true } })),
    }
    const active = await authenticatedHandler({ apiRpc })
    const rejected = [
      rpcFrame(1, { path: '/v1/files' }),
      rpcFrame(2, { method: 'PUT', path: '/v1/assistant/stream', idempotencyKey: 'put-attempt' }),
      rpcFrame(3, { method: 'POST', path: '/v1/assistant/stream' }),
    ]
    const expectedErrors = [
      { code: 'OPERATION_UNAVAILABLE', retryable: true },
      { code: 'OPERATION_UNAVAILABLE', retryable: true },
      { code: 'IDEMPOTENCY_KEY_REQUIRED', retryable: false },
    ]
    for (const [index, frame] of rejected.entries()) {
      enqueue(active.handler, frame)
      await vi.waitFor(() => expect(active.socket.frames.at(-1)?.payload).toEqual(expectedErrors[index]))
    }
    expect(apiRpc.execute).not.toHaveBeenCalled()
    active.handler.disconnect()
  })

  it('bounds concurrent RPCs and handles duplicate ids plus known and unknown flow-control targets', async () => {
    const releases: Array<() => void> = []
    const apiRpc: SyncApiRpcAdapter = {
      idempotencyScope: 'shared-durable',
      ready: () => true,
      operations: () => ['API_RPC'],
      execute: vi.fn<SyncApiRpcAdapter['execute']>(
        (_input, signal) =>
          new Promise((resolve, reject) => {
            releases.push(() => resolve({ status: 200, body: { ok: true } }))
            signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          }),
      ),
    }
    const { handler, socket } = await authenticatedHandler({ apiRpc })
    enqueue(handler, rpcFrame(1, { requestId: 'rpc-active-1' }))
    await vi.waitFor(() => expect(apiRpc.execute).toHaveBeenCalledTimes(1))
    enqueue(handler, rpcFrame(2, { requestId: 'rpc-active-1' }))
    await vi.waitFor(() =>
      expect(socket.frames.at(-1)?.payload).toEqual({ code: 'DUPLICATE_REQUEST', retryable: false }),
    )
    for (let index = 2; index <= 8; index += 1) {
      enqueue(handler, rpcFrame(index + 1, { requestId: `rpc-active-${index}` }))
    }
    await vi.waitFor(() => expect(apiRpc.execute).toHaveBeenCalledTimes(8))
    enqueue(handler, rpcFrame(10, { requestId: 'rpc-over-limit' }))
    await vi.waitFor(() => expect(socket.frames.at(-1)?.payload).toEqual({ code: 'BUSY', retryable: true }))

    enqueue(handler, rpcCreditFrame(11, 'rpc-missing', 1))
    await vi.waitFor(() => expect(socket.frames.at(-1)?.payload).toEqual({ code: 'UNKNOWN_REQUEST', retryable: false }))
    enqueue(handler, rpcCancelFrame(12, 'rpc-missing'))
    await vi.waitFor(() => expect(socket.frames.at(-1)?.payload).toEqual({ code: 'UNKNOWN_REQUEST', retryable: false }))
    enqueue(handler, rpcCancelFrame(13, 'rpc-active-1'))
    await vi.waitFor(() => expect(socket.frames.at(-1)?.payload).toEqual({ code: 'CANCELLED', retryable: false }))
    for (const release of releases) {
      release()
    }
    await vi.waitFor(() => expect(socket.frames.filter((frame) => frame.type === 'RPC_END')).toHaveLength(7))
    handler.disconnect()
  })

  it('keeps socket-local idempotency conflict detection while allowing the two reviewed POST routes', async () => {
    const apiRpc: SyncApiRpcAdapter = {
      idempotencyScope: 'shared-durable',
      ready: () => true,
      operations: () => ['API_RPC', 'STREAM_ASSISTANT'],
      execute: vi.fn(async () => ({ status: 200, body: { ok: true } })),
    }
    const { handler, socket } = await authenticatedHandler({ apiRpc })
    const assistant = {
      method: 'POST' as const,
      path: '/v1/assistant/stream',
      body: { prompt: 'same' },
      idempotencyKey: 'assistant-once',
    }
    enqueue(handler, rpcFrame(1, { requestId: 'assistant-first', ...assistant }))
    await vi.waitFor(() => expect(socket.frames.at(-1)?.type).toBe('RPC_END'))
    enqueue(handler, rpcFrame(2, { requestId: 'assistant-duplicate', ...assistant }))
    await vi.waitFor(() =>
      expect(socket.frames.at(-1)?.payload).toEqual({ code: 'DUPLICATE_REQUEST', retryable: false }),
    )
    enqueue(handler, rpcFrame(3, { requestId: 'assistant-conflict', ...assistant, body: { prompt: 'different' } }))
    await vi.waitFor(() =>
      expect(socket.frames.at(-1)?.payload).toEqual({ code: 'IDEMPOTENCY_KEY_CONFLICT', retryable: false }),
    )
    enqueue(
      handler,
      rpcFrame(4, {
        requestId: 'collaboration-reviewed',
        method: 'POST',
        path: '/v1/collaboration/authorize',
        body: { noteUuid: 'note-1' },
        idempotencyKey: 'collaboration-once',
      }),
    )
    await vi.waitFor(() => expect(socket.frames.at(-1)?.type).toBe('RPC_END'))
    expect(apiRpc.execute).toHaveBeenCalledTimes(2)
    handler.disconnect()
  })

  it('rejects malformed adapter output and streams reviewed body forms without unsafe headers', async () => {
    const apiRpc: SyncApiRpcAdapter = {
      idempotencyScope: 'shared-durable',
      ready: () => true,
      operations: () => ['API_RPC'],
      execute: vi.fn(async (input) => {
        if (input.path === '/v1/rpc/invalid-status') {
          return { status: 99 }
        }
        if (input.path === '/v1/rpc/invalid-stream') {
          return { status: 200, stream: {} as AsyncIterable<Uint8Array> }
        }
        if (input.path === '/v1/rpc/invalid-chunk') {
          return {
            status: 200,
            stream: (async function* () {
              yield 'not-bytes' as unknown as Uint8Array
            })(),
          }
        }
        const body =
          input.path === '/v1/rpc/bytes'
            ? new Uint8Array([1, 2])
            : input.path === '/v1/rpc/string'
              ? 'hello'
              : undefined
        return {
          status: 200,
          headers: {
            'x-request-id': 'safe',
            'Content-Type': 'uppercase-is-not-forwarded',
            etag: 7 as unknown as string,
            'retry-after': 'bad\nvalue',
          },
          body,
        }
      }),
    }
    const { handler, socket } = await authenticatedHandler({ apiRpc })
    const paths = [
      '/v1/rpc/invalid-status',
      '/v1/rpc/invalid-stream',
      '/v1/rpc/invalid-chunk',
      '/v1/rpc/empty',
      '/v1/rpc/bytes',
      '/v1/rpc/string',
    ]
    for (const [index, path] of paths.entries()) {
      enqueue(handler, rpcFrame(index + 1, { requestId: `rpc-shape-${index}`, path, stream: index >= 2 }))
      if (index < 3) {
        await vi.waitFor(() =>
          expect(socket.frames.at(-1)?.payload).toEqual({ code: 'BACKEND_ERROR', retryable: true }),
        )
      } else {
        await vi.waitFor(() =>
          expect(
            socket.frames.some((frame) => frame.type === 'RPC_END' && frame.requestId === `rpc-shape-${index}`),
          ).toBe(true),
        )
      }
    }
    const safeHeaders = payloadOf(
      socket.frames.find((frame) => frame.type === 'RPC_RESPONSE' && frame.requestId === 'rpc-shape-5'),
    ).headers
    expect(safeHeaders).toEqual({ 'x-request-id': 'safe' })
    handler.disconnect()
  })

  it.each([
    ['unsupported method', (payload: JsonObject) => (payload.method = 'OPTIONS')],
    ['absolute path', (payload: JsonObject) => (payload.path = 'https://example.test/v1/users/me')],
    ['short deadline', (payload: JsonObject) => (payload.deadlineMs = 999)],
    ['long deadline', (payload: JsonObject) => (payload.deadlineMs = 120_001)],
    ['fractional credit', (payload: JsonObject) => (payload.initialCreditBytes = 1.5)],
    ['zero credit', (payload: JsonObject) => (payload.initialCreditBytes = 0)],
    ['oversized credit', (payload: JsonObject) => (payload.initialCreditBytes = 4 * 1024 * 1024 + 1)],
    ['invalid stream flag', (payload: JsonObject) => (payload.stream = 'yes')],
    ['invalid headers', (payload: JsonObject) => (payload.headers = { Authorization: 'secret' })],
    ['invalid idempotency key', (payload: JsonObject) => (payload.idempotencyKey = 'bad key')],
    ['GET body', (payload: JsonObject) => (payload.body = { forbidden: true })],
  ])('rejects RPC protocol envelopes with %s', async (_name, mutate) => {
    const active = await authenticatedHandler()
    const frame = rpcFrame(1)
    const payload = frame.payload as JsonObject
    mutate(payload)
    frame.payloadLength = syncPayloadLength(payload)
    enqueue(active.handler, frame)
    await vi.waitFor(() => expect(active.socket.closes.at(-1)?.code).toBe(1008))
    expect(active.socket.frames.at(-1)?.payload).toEqual({ code: 'INVALID_ENVELOPE', retryable: false })
  })

  it('delegates reconnect idempotency to a fleet-shared durable adapter before provider contact', async () => {
    const attempts = new Map<string, Promise<{ status: number; body: unknown }>>()
    const provider = vi.fn(async () => ({ status: 200, body: { response: 'created-once' } }))
    const apiRpc: SyncApiRpcAdapter = {
      idempotencyScope: 'shared-durable',
      ready: () => true,
      operations: () => ['API_RPC', 'STREAM_ASSISTANT'],
      execute: vi.fn(async (input) => {
        const key = input.idempotencyKey as string
        let attempt = attempts.get(key)
        if (!attempt) {
          attempt = provider()
          attempts.set(key, attempt)
        }
        return attempt
      }),
    }
    const first = await authenticatedHandler({ apiRpc })
    const second = await authenticatedHandler({ apiRpc })
    const request = {
      method: 'POST' as const,
      path: '/v1/assistant/stream',
      body: { prompt: 'one attempt' },
      idempotencyKey: 'shared-assistant-attempt',
    }

    enqueue(first.handler, rpcFrame(1, { requestId: 'rpc-first-socket', ...request }))
    enqueue(second.handler, rpcFrame(1, { requestId: 'rpc-second-socket', ...request }))
    await vi.waitFor(() => expect(first.socket.frames.at(-1)?.type).toBe('RPC_END'))
    await vi.waitFor(() => expect(second.socket.frames.at(-1)?.type).toBe('RPC_END'))
    expect(apiRpc.execute).toHaveBeenCalledTimes(2)
    expect(provider).toHaveBeenCalledTimes(1)
    first.handler.disconnect()
    second.handler.disconnect()
  })

  it('consumes a ticket atomically and rejects replay on another replica', async () => {
    const tickets = new InMemorySyncAuthTicketStore()
    const issued = await tickets.issue({ userUuid: 'user-1', sessionUuid: 'session-1', deviceId: 'device-1' })
    const build = (socket: FakeSocket, ownerId: string) =>
      new SyncCommandHandler({
        socket,
        ownerId,
        tickets,
        leases: new InMemorySyncCommandLeaseRegistry(),
        socketBudget: new InMemorySyncSocketBudget(),
        authorization: allowAuthorization(),
        backend: committingBackend(),
        isEnabled: () => true,
      })
    const firstSocket = new FakeSocket()
    const secondSocket = new FakeSocket()
    const first = build(firstSocket, 'replica-1')
    const second = build(secondSocket, 'replica-2')

    enqueue(first, authFrame(issued.ticket))
    await vi.waitFor(() => expect(firstSocket.frames.at(-1)?.type).toBe('AUTHENTICATED'))
    enqueue(second, authFrame(issued.ticket))
    await vi.waitFor(() => expect(secondSocket.closes).toHaveLength(1))
    expect(secondSocket.frames.at(-1)?.payload).toEqual({ code: 'AUTH_REJECTED', retryable: false })
    first.disconnect()
  })

  it('rejects an expired ticket', async () => {
    let now = 1_000
    const tickets = new InMemorySyncAuthTicketStore(() => now)
    const issued = await tickets.issue({ userUuid: 'user-1', sessionUuid: 'session-1', deviceId: 'device-1' }, 1_000)
    now += 1_001
    const socket = new FakeSocket()
    const handler = new SyncCommandHandler({
      socket,
      ownerId: 'owner',
      tickets,
      leases: new InMemorySyncCommandLeaseRegistry(),
      socketBudget: new InMemorySyncSocketBudget(),
      authorization: allowAuthorization(),
      backend: committingBackend(),
      isEnabled: () => true,
    })
    enqueue(handler, authFrame(issued.ticket))
    await vi.waitFor(() => expect(socket.closes.at(-1)?.code).toBe(1008))
    expect(socket.frames.at(-1)?.payload).toEqual({ code: 'AUTH_REJECTED', retryable: false })
  })

  it('fails closed when live authorization becomes stale before a command', async () => {
    const backend = committingBackend()
    const authorization: SyncLiveAuthorizationAdapter = {
      ready: () => true,
      authorize: vi.fn<SyncLiveAuthorizationAdapter['authorize']>(async () => ({
        authorized: false,
        code: 'SESSION_REVOKED',
      })),
    }
    const { handler, socket } = await authenticatedHandler({ authorization, backend })
    enqueue(handler, commandFrame('revoked-command', 1))

    await vi.waitFor(() => expect(socket.frames.at(-1)?.type).toBe('ERROR'))
    expect(socket.frames.at(-1)?.payload).toEqual({ code: 'NOT_AUTHORIZED', retryable: false })
    expect(backend.execute).not.toHaveBeenCalled()
    handler.disconnect()
  })

  it('repeats full authorization immediately before execute and honors a just-revoked policy', async () => {
    const backend = committingBackend()
    const authorization: SyncLiveAuthorizationAdapter = {
      ready: () => true,
      authorize: vi
        .fn<SyncLiveAuthorizationAdapter['authorize']>()
        .mockResolvedValueOnce({ authorized: true })
        .mockResolvedValueOnce({ authorized: false, code: 'SESSION_REVOKED' }),
    }
    const { handler, socket } = await authenticatedHandler({ authorization, backend })
    enqueue(handler, commandFrame('revoked-after-accept', 1))

    await vi.waitFor(() => expect(socket.frames.at(-1)?.type).toBe('ERROR'))
    expect(socket.frames.map((frame) => frame.type)).toEqual(['AUTHENTICATED', 'ACCEPTED', 'ERROR'])
    expect(socket.frames.at(-1)?.payload).toEqual({ code: 'NOT_AUTHORIZED', retryable: false })
    expect(authorization.authorize).toHaveBeenCalledTimes(2)
    expect(backend.execute).not.toHaveBeenCalled()
    await handler.stop()
  })

  it.each([
    ['READ_ONLY', 'READ_ONLY'],
    ['CONTENT_LIMIT', 'CONTENT_LIMIT'],
    ['SHARED_VAULT_FORBIDDEN', 'NOT_AUTHORIZED'],
  ] as const)('maps %s authorization without leaking policy detail', async (authorizationCode, publicCode) => {
    const authorization: SyncLiveAuthorizationAdapter = {
      ready: () => true,
      authorize: vi.fn(async () => ({ authorized: false, code: authorizationCode })),
    }
    const { handler, socket } = await authenticatedHandler({ authorization })
    enqueue(handler, commandFrame(`denied-${authorizationCode}`, 1))
    await vi.waitFor(() => expect(socket.frames.at(-1)?.type).toBe('ERROR'))
    expect(socket.frames.at(-1)?.payload).toEqual({ code: publicCode, retryable: false })
    handler.disconnect()
  })

  it('enforces exact client order and resumes server sequence', async () => {
    const { handler, socket } = await authenticatedHandler({ resumeSequence: 7 })
    expect(socket.frames[0].sequence).toBe(8)
    enqueue(handler, pingFrame(2))
    await vi.waitFor(() => expect(socket.closes.at(-1)?.code).toBe(1008))
    expect(socket.frames.at(-1)?.payload).toEqual({ code: 'OUT_OF_ORDER', retryable: false })
  })

  it('returns reconnect STATUS using the same digest and next server sequence', async () => {
    const body = { api: '20200115', items: [] }
    const digest = digestSyncCommandBody(body)
    const { handler, socket } = await authenticatedHandler({ resumeSequence: 40 })
    enqueue(handler, statusFrame('command-1', 1, digest))
    await vi.waitFor(() => expect(socket.frames.at(-1)?.type).toBe('STATUS'))
    expect(socket.frames.at(-1)).toMatchObject({
      sequence: 42,
      digest,
      payload: { status: 'COMMITTED', result: { saved: true } },
    })
    handler.disconnect()
  })

  it('authorizes STATUS live and rejects a backend digest conflict', async () => {
    const digest = 'a'.repeat(64)
    const deniedAuthorization: SyncLiveAuthorizationAdapter = {
      ready: () => true,
      authorize: vi.fn<SyncLiveAuthorizationAdapter['authorize']>(async () => ({
        authorized: false,
        code: 'SESSION_REVOKED',
      })),
    }
    const denied = await authenticatedHandler({ authorization: deniedAuthorization })
    enqueue(denied.handler, statusFrame('status-denied', 1, digest))
    await vi.waitFor(() => expect(denied.socket.frames.at(-1)?.type).toBe('ERROR'))
    expect(denied.socket.frames.at(-1)?.payload).toEqual({ code: 'NOT_AUTHORIZED', retryable: false })

    const conflictingBackend: SyncCommandBackendAdapter = {
      ready: () => true,
      execute: vi.fn(async (input) => ({ digest: input.digest })),
      status: vi.fn<SyncCommandBackendAdapter['status']>(async () => ({ status: 'COMMITTED', digest: 'b'.repeat(64) })),
    }
    const conflicting = await authenticatedHandler({ backend: conflictingBackend })
    enqueue(conflicting.handler, statusFrame('status-conflict', 1, digest))
    await vi.waitFor(() => expect(conflicting.socket.frames.at(-1)?.type).toBe('ERROR'))
    expect(conflicting.socket.frames.at(-1)?.payload).toEqual({ code: 'COMMAND_ID_CONFLICT', retryable: false })
    denied.handler.disconnect()
    conflicting.handler.disconnect()
  })

  it('returns backend errors for failed STATUS without closing the authenticated socket', async () => {
    const backend: SyncCommandBackendAdapter = {
      ready: () => true,
      execute: vi.fn(async (input) => ({ digest: input.digest })),
      status: vi.fn(async () => Promise.reject(new Error('status unavailable'))),
    }
    const { handler, socket } = await authenticatedHandler({ backend })
    enqueue(handler, statusFrame('status-error', 1, 'a'.repeat(64)))
    await vi.waitFor(() => expect(socket.frames.at(-1)?.payload).toEqual({ code: 'BACKEND_ERROR', retryable: true }))
    expect(socket.closes).toHaveLength(0)
    handler.disconnect()
  })

  it('allows only one in-flight command per user/device across handlers', async () => {
    const tickets = new InMemorySyncAuthTicketStore()
    const leases = new InMemorySyncCommandLeaseRegistry()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const backend: SyncCommandBackendAdapter = {
      ready: () => true,
      execute: vi.fn(async (input) => {
        await gate
        return { digest: input.digest }
      }),
      status: vi.fn<SyncCommandBackendAdapter['status']>(async (input) => ({
        status: 'UNKNOWN',
        digest: input.digest,
      })),
    }
    const first = await authenticatedHandler({ tickets, leases, backend })
    const second = await authenticatedHandler({ tickets, leases, backend })
    enqueue(first.handler, commandFrame('command-A', 1))
    await vi.waitFor(() => expect(first.socket.frames.at(-1)?.type).toBe('ACCEPTED'))
    enqueue(second.handler, commandFrame('command-B', 1))
    await vi.waitFor(() => expect(second.socket.frames.at(-1)?.type).toBe('ERROR'))
    expect(second.socket.frames.at(-1)?.payload).toEqual({ code: 'BUSY', retryable: true })
    release()
    await vi.waitFor(() => expect(first.socket.frames.at(-1)?.type).toBe('COMMITTED'))
    first.handler.disconnect()
    second.handler.disconnect()
  })

  it('renews an active distributed lease and releases it after commit', async () => {
    const leases = new InMemorySyncCommandLeaseRegistry()
    const renew = vi.spyOn(leases, 'renew')
    const releaseLease = vi.fn<() => void>()
    const backend: SyncCommandBackendAdapter = {
      ready: () => true,
      execute: vi.fn<SyncCommandBackendAdapter['execute']>(
        async (input) =>
          new Promise((resolve) => {
            releaseLease.mockImplementation(() => resolve({ digest: input.digest }))
          }),
      ),
      status: vi.fn<SyncCommandBackendAdapter['status']>(async (input) => ({
        status: 'UNKNOWN',
        digest: input.digest,
      })),
    }
    const active = await authenticatedHandler({ leases, backend, leaseRenewIntervalMs: 5 })
    enqueue(active.handler, commandFrame('renewed-command', 1))
    await vi.waitFor(() => expect(active.socket.frames.at(-1)?.type).toBe('ACCEPTED'))
    await vi.waitFor(() => expect(renew).toHaveBeenCalled())
    releaseLease()
    await vi.waitFor(() => expect(active.socket.frames.at(-1)?.type).toBe('COMMITTED'))
    await expect(
      leases.acquire({
        userUuid: 'user-1',
        deviceId: 'device-1',
        commandId: 'next-command',
        digest: 'a'.repeat(64),
        ownerId: 'next-owner',
      }),
    ).resolves.toEqual({ acquired: true })
    await active.handler.stop()
  })

  it('aborts durable execution and returns retryable LEASE_LOST when renewal loses ownership', async () => {
    const backing = new InMemorySyncCommandLeaseRegistry()
    const leases: SyncCommandLeaseRegistry = {
      distribution: 'shared',
      ready: () => true,
      // InMemorySyncCommandLeaseRegistry declares acquire/release as (input) only,
      // so the signal cannot be forwarded. It was being dropped on the floor before
      // too — the impl has no second parameter — so this is the same call, typed.
      acquire: (input) => backing.acquire(input),
      renew: vi.fn(async () => false),
      release: (input) => backing.release(input),
    }
    const backend: SyncCommandBackendAdapter = {
      ready: () => true,
      execute: vi.fn<SyncCommandBackendAdapter['execute']>(
        async (_input, signal) =>
          new Promise((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
          ),
      ),
      status: vi.fn<SyncCommandBackendAdapter['status']>(async (input) => ({
        status: 'UNKNOWN',
        digest: input.digest,
      })),
    }
    const active = await authenticatedHandler({ leases, backend, leaseRenewIntervalMs: 5 })
    enqueue(active.handler, commandFrame('lost-command', 1))
    await vi.waitFor(() =>
      expect(active.socket.frames.at(-1)?.payload).toEqual({ code: 'LEASE_LOST', retryable: true }),
    )
    expect(leases.renew).toHaveBeenCalled()
    await active.handler.stop()
  })

  it('times out an unresponsive backend, returns a retryable error, and releases the lease', async () => {
    const backend: SyncCommandBackendAdapter = {
      ready: () => true,
      execute: vi.fn<SyncCommandBackendAdapter['execute']>(() => new Promise(() => undefined)),
      status: vi.fn<SyncCommandBackendAdapter['status']>(async (input) => ({
        status: 'UNKNOWN',
        digest: input.digest,
      })),
    }
    const leases = new InMemorySyncCommandLeaseRegistry()
    const { handler, socket } = await authenticatedHandler({ backend, leases, backendTimeoutMs: 5 })
    enqueue(handler, commandFrame('slow-command', 1))
    await vi.waitFor(() => expect(socket.frames.at(-1)?.payload).toEqual({ code: 'BACKEND_TIMEOUT', retryable: true }))
    await expect(
      leases.acquire({
        userUuid: 'user-1',
        deviceId: 'device-1',
        commandId: 'next-command',
        digest: 'a'.repeat(64),
        ownerId: 'new-owner',
      }),
    ).resolves.toEqual({ acquired: true })
    handler.disconnect()
  })

  it('detects a committed digest conflict and supports a committed response without result data', async () => {
    const conflictingBackend: SyncCommandBackendAdapter = {
      ready: () => true,
      execute: vi.fn(async () => ({ digest: 'b'.repeat(64) })),
      status: vi.fn<SyncCommandBackendAdapter['status']>(async (input) => ({
        status: 'UNKNOWN',
        digest: input.digest,
      })),
    }
    const conflict = await authenticatedHandler({ backend: conflictingBackend })
    enqueue(conflict.handler, commandFrame('command-conflict', 1))
    await vi.waitFor(() => expect(conflict.socket.frames.at(-1)?.type).toBe('ERROR'))
    expect(conflict.socket.frames.at(-1)?.payload).toEqual({ code: 'COMMAND_ID_CONFLICT', retryable: false })

    const noResultBackend: SyncCommandBackendAdapter = {
      ready: () => true,
      execute: vi.fn(async (input) => ({ digest: input.digest })),
      status: vi.fn<SyncCommandBackendAdapter['status']>(async (input) => ({
        status: 'UNKNOWN',
        digest: input.digest,
      })),
    }
    const noResult = await authenticatedHandler({ backend: noResultBackend })
    enqueue(noResult.handler, commandFrame('command-no-result', 1))
    await vi.waitFor(() => expect(noResult.socket.frames.at(-1)?.type).toBe('COMMITTED'))
    expect(noResult.socket.frames.at(-1)?.payload).toEqual({ status: 'COMMITTED' })
    conflict.handler.disconnect()
    noResult.handler.disconnect()
  })

  it('closes a slow consumer without retaining more egress', async () => {
    const { handler, socket } = await authenticatedHandler()
    const frameCount = socket.frames.length
    socket.bufferedAmount = MAX_SYNC_BUFFERED_BYTES
    enqueue(handler, pingFrame(1))
    await vi.waitFor(() => expect(socket.closes.at(-1)?.code).toBe(1013))
    expect(socket.frames).toHaveLength(frameCount)
  })

  it('never enqueues an oversized result and emits only a small retryable fallback signal', async () => {
    const backend: SyncCommandBackendAdapter = {
      ready: () => true,
      execute: vi.fn(async (input) => ({ digest: input.digest, payload: { huge: 'x'.repeat(MAX_SYNC_FRAME_BYTES) } })),
      status: vi.fn<SyncCommandBackendAdapter['status']>(async (input) => ({
        status: 'UNKNOWN',
        digest: input.digest,
      })),
    }
    const { handler, socket } = await authenticatedHandler({ backend })
    enqueue(handler, commandFrame('large-result', 1))
    await vi.waitFor(() => expect(socket.frames.at(-1)?.payload).toEqual({ code: 'RESULT_TOO_LARGE', retryable: true }))
    expect(socket.frames.some((frame) => frame.type === 'COMMITTED')).toBe(false)
    expect(
      socket.frames.every((frame) => Buffer.byteLength(JSON.stringify(frame), 'utf8') <= MAX_SYNC_FRAME_BYTES),
    ).toBe(true)
    await handler.stop()
  })

  it('uses exact predicted bufferedAmount accounting at the boundary', async () => {
    const { handler, socket } = await authenticatedHandler()
    const firstPong = JSON.stringify(
      createSyncServerFrame({
        type: 'PONG',
        requestId: 'ping-request',
        commandId: 'ping-command',
        sequence: 2,
        payload: {},
      }),
    )
    socket.bufferedAmount = MAX_SYNC_BUFFERED_BYTES - Buffer.byteLength(firstPong, 'utf8')
    enqueue(handler, pingFrame(1))
    await vi.waitFor(() => expect(socket.frames.at(-1)?.type).toBe('PONG'))

    const frameCount = socket.frames.length
    const secondPong = JSON.stringify(
      createSyncServerFrame({
        type: 'PONG',
        requestId: 'ping-request',
        commandId: 'ping-command',
        sequence: 3,
        payload: {},
      }),
    )
    socket.bufferedAmount = MAX_SYNC_BUFFERED_BYTES - Buffer.byteLength(secondPong, 'utf8') + 1
    enqueue(handler, pingFrame(2))
    await vi.waitFor(() => expect(socket.closes.at(-1)?.code).toBe(1013))
    expect(socket.frames).toHaveLength(frameCount)
  })

  it('enforces the authenticated per-user socket budget and fully releases it on stop', async () => {
    const budget = new InMemorySyncSocketBudget(1)
    const first = await authenticatedHandler({ socketBudget: budget, ownerId: 'socket-owner-1' })

    const tickets = new InMemorySyncAuthTicketStore()
    const issued = await tickets.issue({ userUuid: 'user-1', sessionUuid: 'session-2', deviceId: 'device-2' })
    const secondSocket = new FakeSocket()
    const second = new SyncCommandHandler({
      socket: secondSocket,
      ownerId: 'socket-owner-2',
      tickets,
      leases: new InMemorySyncCommandLeaseRegistry(),
      socketBudget: budget,
      authorization: allowAuthorization(),
      backend: committingBackend(),
      isEnabled: () => true,
    })
    enqueue(second, authFrame(issued.ticket, 'device-2'))
    await vi.waitFor(() =>
      expect(secondSocket.frames.at(-1)?.payload).toEqual({ code: 'SOCKET_LIMIT', retryable: true }),
    )

    await first.handler.stop()
    const third = await authenticatedHandler({ socketBudget: budget, ownerId: 'socket-owner-3' })
    expect(third.socket.frames.at(-1)?.type).toBe('AUTHENTICATED')
    await Promise.all([second.stop(), third.handler.stop()])
  })

  it('fails closed when the fleet socket reservation cannot be renewed', async () => {
    const release = vi.fn(async () => undefined)
    const budget: SyncSocketBudget = {
      distribution: 'shared',
      ready: () => true,
      acquire: vi.fn(async () => true),
      renew: vi.fn(async () => false),
      release,
    }
    const active = await authenticatedHandler({
      socketBudget: budget,
      ownerId: 'expiring-socket',
      socketBudgetRenewIntervalMs: 200,
    })
    await vi.waitFor(() =>
      expect(active.socket.frames.at(-1)?.payload).toEqual({ code: 'SOCKET_BUDGET_LOST', retryable: true }),
    )
    expect(active.socket.closes.at(-1)?.code).toBe(1013)
    await active.handler.stop()
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('closes safely when a bounded resume sequence exhausts the server sequence space', async () => {
    const { handler, socket } = await authenticatedHandler({ resumeSequence: MAX_SYNC_RESUME_SEQUENCE })
    expect(socket.frames.at(-1)?.sequence).toBe(MAX_SYNC_RESUME_SEQUENCE + 1)
    const frameCount = socket.frames.length
    enqueue(handler, pingFrame(1))
    await vi.waitFor(() => expect(socket.closes.at(-1)?.code).toBe(1008))
    expect(socket.frames).toHaveLength(frameCount)
  })
})
