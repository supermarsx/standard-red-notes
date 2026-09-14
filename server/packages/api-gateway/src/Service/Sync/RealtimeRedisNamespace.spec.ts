import { RedisInviteEventAvailabilityBus, RedisInviteEventStore } from '@standard-red-notes/websocket-gateway'

import { resolveRealtimeRedisNamespace, SQS_DEDUP_KEY_PREFIX } from './RealtimeRedisNamespace'

describe('resolveRealtimeRedisNamespace (C10)', () => {
  it.each([undefined, '', '   '])('keeps the historical names when the namespace is %j', (raw) => {
    expect(resolveRealtimeRedisNamespace(raw)).toEqual({ namespace: undefined, sqsDedupKeyPrefix: 'ws:sqs:event:v1:' })
  })

  // N17: the dedup prefix must be `<ns>:ws:sqs:event:v1:`, the exact format the
  // gateway's own `namespacedDedupPrefix` produces, or two stacks share claims.
  it('prefixes the SQS dedup keys with the namespace and a colon', () => {
    expect(resolveRealtimeRedisNamespace('tenant-a')).toEqual({
      namespace: 'tenant-a',
      sqsDedupKeyPrefix: `tenant-a:${SQS_DEDUP_KEY_PREFIX}`,
    })
  })

  it.each(['Tenant A', 'a b', ':a', 'a:', 'x'.repeat(65)])('refuses %j and names the variable, never the value', (raw) => {
    expect(() => resolveRealtimeRedisNamespace(raw)).toThrow(/WEBSOCKET_REDIS_NAMESPACE/)
    expect(() => resolveRealtimeRedisNamespace(raw)).not.toThrow(raw)
  })

  // The value bin/server.ts resolves is the one both invite-event consumers
  // accept (their constructors take `{ namespace }`); a validated namespace can
  // therefore never trip their INVITE_REDIS_NAMESPACE_INVALID at construction.
  it('is accepted verbatim by the invite-event store and availability bus', () => {
    const { namespace } = resolveRealtimeRedisNamespace('tenant-a')
    const redis = { status: 'ready', on: jest.fn() } as never

    expect(() => new RedisInviteEventStore(redis, { cursorSecret: 'x'.repeat(32), namespace })).not.toThrow()
    expect(() => new RedisInviteEventAvailabilityBus(redis, redis, { namespace })).not.toThrow()
  })
})
